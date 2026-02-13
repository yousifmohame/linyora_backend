// backend/controllers/orderController.js

const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates");
const { recordTransaction } = require("./walletController"); // 👈 Wallet engine import
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ===================================================================================
//  HELPER FUNCTIONS 🛠️
// ===================================================================================

/**
 * @private
 * @desc    Updates stock levels + sends low stock alerts
 */
const updateStockLevels = async (item, connection) => {
  // 1. Update Merchant Stock
  await connection.query(
    "UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
    [item.quantity, item.id],
  );

  // Check merchant stock level
  const [[variant]] = await connection.query(
    `SELECT pv.stock_quantity, p.name, u.email, u.name as userName 
     FROM product_variants pv 
     JOIN products p ON pv.product_id = p.id 
     JOIN users u ON p.merchant_id = u.id 
     WHERE pv.id = ?`,
    [item.id],
  );

  if (variant && variant.stock_quantity <= 5) {
    sendEmail({
      to: variant.email,
      subject: `Alert: Low Stock for ${variant.name}`,
      html: templates.lowStockWarning(
        variant.userName,
        variant.name,
        variant.stock_quantity,
      ),
    }).catch(console.error);
  }

  // 2. Check Dropshipping (Supplier Stock)
  const [[link]] = await connection.query(
    "SELECT supplier_variant_id FROM dropship_links WHERE merchant_variant_id = ?",
    [item.id],
  );

  if (link && link.supplier_variant_id) {
    await connection.query(
      "UPDATE supplier_product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
      [item.quantity, link.supplier_variant_id],
    );

    // Check supplier stock level
    const [[supplierVariant]] = await connection.query(
      `SELECT spv.stock_quantity, sp.name, u.email, u.name as userName 
         FROM supplier_product_variants spv 
         JOIN supplier_products sp ON spv.product_id = sp.id 
         JOIN users u ON sp.supplier_id = u.id 
         WHERE spv.id = ?`,
      [link.supplier_variant_id],
    );

    if (supplierVariant && supplierVariant.stock_quantity <= 5) {
      sendEmail({
        to: supplierVariant.email,
        subject: `Alert: Low Stock for ${supplierVariant.name}`,
        html: templates.lowStockWarning(
          supplierVariant.userName,
          supplierVariant.name,
          supplierVariant.stock_quantity,
        ),
      }).catch(console.error);
    }
  }
};

/**
 * @private
 * @desc    Registers products, updates stock, identifies suppliers for notification
 */
const processOrderItems = async (orderId, items, connection) => {
  const suppliersToNotify = new Map();

  for (const item of items) {
    // 1. Insert Item
    await connection.query(
      "INSERT INTO order_items (order_id, product_id, product_variant_id, quantity, price) VALUES (?, ?, ?, ?, ?)",
      [orderId, item.productId, item.id, item.quantity, item.price],
    );

    // 2. Update Stock
    await updateStockLevels(item, connection);

    // 3. Check if Supplier Item
    const [[productInfo]] = await connection.query(
      `SELECT sp.supplier_id, u.email, u.name 
         FROM dropship_links dl
         JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
         JOIN supplier_products sp ON spv.product_id = sp.id
         JOIN users u ON sp.supplier_id = u.id
         WHERE dl.merchant_variant_id = ?`,
      [item.id],
    );

    if (productInfo) {
      const { supplier_id, email, name } = productInfo;
      if (!suppliersToNotify.has(supplier_id)) {
        suppliersToNotify.set(supplier_id, { email, name, items: [] });
      }
      suppliersToNotify.get(supplier_id).items.push(item.name);
    }
  }

  return suppliersToNotify;
};

// ===================================================================================
//  🔥 FINANCIAL ENGINE (النسخة الشاملة: تسجيل الخصومات في كل الحالات)
// ===================================================================================
const calculateAndRegisterEarnings = async (orderId, connection) => {
  console.log(`💰 [Finance] Starting Split Calculation for Order #${orderId}`);

  // 1. بيانات الطلب
  const [[orderMeta]] = await connection.query(
    "SELECT payment_method, shipping_cost, shipping_company_id FROM orders WHERE id = ?",
    [orderId],
  );

  const isCOD = orderMeta.payment_method === "cod";
  const globalShippingCost = Number(orderMeta.shipping_cost || 0);

  // 2. الإعدادات
  const [settings] = await connection.query(
    "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('commission_rate', 'shipping_commission_rate', 'clearance_days')",
  );
  const config = settings.reduce((acc, row) => {
    acc[row.setting_key] = parseFloat(row.setting_value);
    return acc;
  }, {});

  const commissionRate = (config.commission_rate || 10) / 100;
  const shippingCommRate = (config.shipping_commission_rate || 10) / 100;
  const clearanceDays = config.clearance_days || 14;
  const availableAt = new Date();
  availableAt.setDate(availableAt.getDate() + clearanceDays);

  // 3. جلب العناصر
  const [items] = await connection.query(
    `SELECT oi.*, p.merchant_id, p.name as product_name, 
            sp.supplier_id, spv.cost_price 
     FROM order_items oi
     JOIN products p ON oi.product_id = p.id
     LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
     LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
     LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
     LEFT JOIN supplier_products sp ON spv.product_id = sp.id
     WHERE oi.order_id = ?`,
    [orderId],
  );

  const firstSupplierItem = items.find((i) => i.supplier_id);
  const defaultShippingOwnerId = firstSupplierItem
    ? firstSupplierItem.supplier_id
    : items[0]?.merchant_id;

  // --- دالة مساعدة لتسجيل العمليات (إجمالي + خصم) ---
  const registerSplitTransaction = async (
    userId,
    grossAmount,
    commissionAmount,
    desc,
    typeOverride = "sale_earning",
  ) => {
    if (isCOD) {
      // COD: نخصم العمولة فقط (لأن التاجر معه الكاش)
      await recordTransaction(
        {
          userId,
          amount: -commissionAmount, // بالسالب
          type: "cod_commission_deduction",
          status: "cleared", // دين حال
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `خصم عمولة منصة (${desc})`,
          availableAt: null,
        },
        connection,
      );
    } else {
      // Card: نسجل الإيداع الكلي ثم نخصم العمولة (لتوحيد التقارير)

      // 1. إيداع المبلغ الكلي (إجمالي المبيعات)
      await recordTransaction(
        {
          userId,
          amount: grossAmount,
          type: typeOverride,
          status: "pending",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `إجمالي مبيعات (${desc})`,
          availableAt,
        },
        connection,
      );

      // 2. خصم العمولة (هنا يتم تسجيل الخصم الذي كنت تبحث عنه)
      await recordTransaction(
        {
          userId,
          amount: -commissionAmount,
          type: "commission_deduction", // نوع جديد لتمييزه عن COD
          status: "pending", // معلق لأنه يخصم من رصيد معلق
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `خصم عمولة منصة (${desc})`,
          availableAt, // يتحرر الخصم مع تحرر المبلغ الأصلي
        },
        connection,
      );
    }
  };

  // 4. معالجة المنتجات
  for (const item of items) {
    const qty = Number(item.quantity);
    const sellingPriceTotal = Number(item.price) * qty;

    if (item.supplier_id && item.cost_price) {
      // --- دروبشيبينغ ---
      const costPriceTotal = Number(item.cost_price) * qty;
      const supplierCommission = costPriceTotal * commissionRate;

      // المورد: (له التكلفة، عليه عمولة)
      await registerSplitTransaction(
        item.supplier_id,
        costPriceTotal,
        supplierCommission,
        `منتج: ${item.product_name}`,
      );

      // التاجر: (له الربح، عليه عمولة)
      const grossProfit = sellingPriceTotal - costPriceTotal;
      const merchantCommission = grossProfit * commissionRate;

      await registerSplitTransaction(
        item.merchant_id,
        grossProfit,
        merchantCommission,
        `ربح بيع: ${item.product_name}`,
      );
    } else {
      // --- منتج عادي ---
      const merchantCommission = sellingPriceTotal * commissionRate;

      await registerSplitTransaction(
        item.merchant_id,
        sellingPriceTotal,
        merchantCommission,
        `منتج: ${item.product_name}`,
      );
    }
  }

  // =========================================================
  // 5. معالجة الشحن (تطبيق نفس المنطق)
  // =========================================================

  const processShippingTransaction = async (ownerId, cost, descName) => {
    const shipFee = cost * shippingCommRate;

    if (isCOD) {
      // COD: خصم فقط
      await recordTransaction(
        {
          userId: ownerId,
          amount: -shipFee,
          type: "cod_commission_deduction",
          status: "cleared",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `خصم عمولة شحن (${descName})`,
          availableAt: null,
        },
        connection,
      );
    } else {
      // Card: إيداع شحن + خصم عمولة

      // 1. إيداع الشحن
      await recordTransaction(
        {
          userId: ownerId,
          amount: cost,
          type: "shipping_earning",
          status: "pending",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `عائد شحن (${descName})`,
          availableAt,
        },
        connection,
      );

      // 2. خصم العمولة
      await recordTransaction(
        {
          userId: ownerId,
          amount: -shipFee,
          type: "commission_deduction",
          status: "pending",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `خصم عمولة شحن (${descName})`,
          availableAt,
        },
        connection,
      );
    }
  };

  // أ) البحث في جدول الاختيارات
  const [shippingSelections] = await connection.query(
    "SELECT * FROM order_shipping_selections WHERE order_id = ?",
    [orderId],
  );

  let shippingHandled = false;

  if (shippingSelections.length > 0) {
    for (const sel of shippingSelections) {
      const [[company]] = await connection.query(
        "SELECT shipping_cost, merchant_id as owner_id, name FROM shipping_companies WHERE id = ?",
        [sel.shipping_option_id],
      );
      if (company) {
        await processShippingTransaction(
          company.owner_id,
          Number(company.shipping_cost),
          company.name,
        );
        shippingHandled = true;
      }
    }
  }

  // ب) الخطة البديلة (Fallback)
  if (!shippingHandled && globalShippingCost > 0) {
    let shippingOwnerId = defaultShippingOwnerId;
    let companyName = "شحن عام";

    if (orderMeta.shipping_company_id) {
      const [[company]] = await connection.query(
        "SELECT merchant_id as owner_id, name FROM shipping_companies WHERE id = ?",
        [orderMeta.shipping_company_id],
      );
      if (company) {
        shippingOwnerId = company.owner_id;
        companyName = company.name;
      }
    }

    if (shippingOwnerId) {
      await processShippingTransaction(
        shippingOwnerId,
        globalShippingCost,
        companyName,
      );
    }
  }
};

/**
 * @desc    الدالة الجوهرية لإنشاء الطلبات (Unified Internal Logic)
 */
exports.createOrderInternal = async (orderPayload) => {
  const {
    customerId,
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost, // ✅ هذا هو المتغير المهم القادم من الفرونت في حالة COD
    shipping_company_id, // ✅ وهذا أيضاً
    paymentMethod,
    paymentStatus,
    stripe_session_id,
  } = orderPayload;

  const connection = await pool.getConnection();
  const createdOrderIds = [];
  const emailsToSend = [];

  try {
    await connection.beginTransaction();

    const [[customer]] = await connection.query(
      "SELECT name, email FROM users WHERE id = ?",
      [customerId],
    );

    // 1. تجهيز العناصر
    const processedItems = [];
    for (const item of cartItems) {
      let variantId = item.variantId || item.id;
      if (!variantId && item.productId) {
        const [v] = await connection.query(
          "SELECT id, price FROM product_variants WHERE product_id = ? LIMIT 1",
          [item.productId],
        );
        if (v.length > 0) variantId = v[0].id;
        else throw new Error(`المنتج رقم ${item.productId} غير متوفر.`);
      }
      processedItems.push({ ...item, variantId });
    }

    // 2. معالجة العروض الخاطفة
    for (const item of processedItems) {
      const [flashSaleInfo] = await connection.query(
        `SELECT fsp.id, fsp.sold_quantity, fsp.total_quantity 
         FROM flash_sale_products fsp
         JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
         WHERE fsp.variant_id = ? AND fsp.status = 'accepted' AND fs.is_active = 1 
         AND NOW() BETWEEN fs.start_time AND fs.end_time FOR UPDATE`,
        [item.variantId],
      );

      if (flashSaleInfo.length > 0) {
        if (
          flashSaleInfo[0].sold_quantity + item.quantity >
          flashSaleInfo[0].total_quantity
        ) {
          throw new Error(`الكمية المتاحة في العرض الخاطف قد نفذت.`);
        }
        await connection.query(
          "UPDATE flash_sale_products SET sold_quantity = sold_quantity + ? WHERE id = ?",
          [item.quantity, flashSaleInfo[0].id],
        );
      }
    }

    // 3. تجميع الطلبات
    const variantIds = processedItems.map((i) => i.variantId);
    const [variantsInfo] = await connection.query(
      `SELECT pv.id as variant_id, p.merchant_id FROM product_variants pv JOIN products p ON pv.product_id = p.id WHERE pv.id IN (?)`,
      [variantIds],
    );
    const merchantMap = {};
    variantsInfo.forEach((v) => (merchantMap[v.variant_id] = v.merchant_id));

    const ordersMap = new Map();
    for (const item of processedItems) {
      const merchantId = merchantMap[item.variantId];
      if (!ordersMap.has(merchantId))
        ordersMap.set(merchantId, { merchantId, items: [], total: 0 });
      const group = ordersMap.get(merchantId);
      group.items.push(item);
      group.total += Number(item.price) * item.quantity;
    }

    // 4. إنشاء الطلبات
    for (const [merchantId, group] of ordersMap.entries()) {
      let finalShippingCost = 0;
      let finalShippingCompanyId = null;

      // أ) محاولة العثور على خيار شحن محدد (الأولوية)
      if (
        merchant_shipping_selections &&
        Array.isArray(merchant_shipping_selections)
      ) {
        const selection = merchant_shipping_selections.find(
          (s) => String(s.merchant_id) === String(merchantId),
        );
        if (selection) {
          const [[company]] = await connection.query(
            "SELECT id, shipping_cost FROM shipping_companies WHERE id = ?",
            [selection.shipping_option_id],
          );
          if (company) {
            finalShippingCost = Number(company.shipping_cost);
            finalShippingCompanyId = company.id;
          }
        }
      }

      // ب) 🔥 الإصلاح: إذا لم نجد اختياراً، نستخدم الشحن العام المرسل (خاص بـ COD)
      // شرط: ألا يكون قد تم تعيين شحن سابقاً، وأن يكون هناك قيمة مرسلة
      if (finalShippingCost === 0 && Number(shipping_cost) > 0) {
        // إذا كان الطلب مقسماً لعدة تجار، قد نحتاج لمنطق لتقسيم الشحن،
        // لكن هنا للتبسيط ولأن غالباً الطلب لتاجر واحد أو شحن موحد:
        finalShippingCost = Number(shipping_cost);
        finalShippingCompanyId = shipping_company_id || null;
      }

      let orderTotal = group.total + finalShippingCost;

      // إضافة رسوم الدفع عند الاستلام
      if (paymentMethod === "cod") {
        const [[set]] = await connection.query(
          "SELECT setting_value FROM platform_settings WHERE setting_key = 'cod_fee'",
        );
        orderTotal += Number(set?.setting_value || 15);
      }

      // إدراج الطلب
      const [res] = await connection.query(
        `INSERT INTO orders (customer_id, status, payment_status, payment_method, total_amount, shipping_address_id, shipping_company_id, shipping_cost, stripe_payment_intent_id) 
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          paymentStatus,
          paymentMethod,
          orderTotal,
          shippingAddressId,
          finalShippingCompanyId, // ✅ سيتم حفظه الآن
          finalShippingCost, // ✅ سيتم حفظ التكلفة الآن
          stripe_session_id,
        ],
      );
      const orderId = res.insertId;
      createdOrderIds.push(orderId);

      // حفظ خيار الشحن في الجدول الفرعي لضمان الحسابات الدقيقة لاحقاً
      if (finalShippingCompanyId) {
        await connection.query(
          "INSERT INTO order_shipping_selections (order_id, merchant_id, shipping_option_id) VALUES (?, ?, ?)",
          [orderId, merchantId, finalShippingCompanyId],
        );
      }

      // معالجة العناصر
      await processOrderItems(orderId, group.items, connection);

      // إذا مدفوع (بطاقة)، سجل الأرباح فوراً
      if (paymentStatus === "paid") {
        await calculateAndRegisterEarnings(orderId, connection);
      }

      // إشعار
      if (customer) {
        emailsToSend.push({
          to: customer.email,
          subject: `تأكيد الطلب #${orderId}`,
          html: templates.orderConfirmation(
            customer.name,
            orderId,
            orderTotal.toFixed(2),
            group.items,
          ),
        });
      }
    }

    await connection.commit();
    Promise.allSettled(emailsToSend.map((e) => sendEmail(e))).catch(
      console.error,
    );
    return createdOrderIds;
  } catch (error) {
    await connection.rollback();
    console.error("Order Creation Error:", error);
    throw error;
  } finally {
    connection.release();
  }
};

// ===================================================================================
//  API HANDLERS
// ===================================================================================

exports.createCodOrder = asyncHandler(async (req, res) => {
  const {
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost,
    shipping_company_id, // ✅ استقبال معرف شركة الشحن
  } = req.body;

  if (!cartItems || !cartItems.length)
    return res.status(400).json({ message: "السلة فارغة" });

  try {
    const orderIds = await exports.createOrderInternal({
      customerId: req.user.id,
      cartItems,
      shippingAddressId,
      merchant_shipping_selections,
      shipping_cost, // ✅ تمرير الشحن
      shipping_company_id, // ✅ تمرير معرف الشركة
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      stripe_session_id: null,
    });
    res.status(201).json({ message: "تم الطلب بنجاح", orderIds });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

exports.createOrderFromIntent = asyncHandler(async (req, res) => {
  const {
    paymentIntentId,
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost,
  } = req.body;

  if (!stripe) return res.status(500).json({ message: "Stripe Config Error" });

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== "succeeded")
    return res.status(400).json({ message: "فشل الدفع" });

  try {
    const orderIds = await exports.createOrderInternal({
      customerId: req.user.id,
      cartItems,
      shippingAddressId,
      merchant_shipping_selections,
      shipping_cost,
      paymentMethod: "card",
      paymentStatus: "paid",
      stripe_session_id: paymentIntentId,
    });
    res.status(201).json({ message: "تم الدفع والطلب بنجاح", orderIds });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * @desc    إنشاء طلب بعد الدفع بالبطاقة (يسجل الأرباح فوراً)
 */
exports.createOrderFromIntent = asyncHandler(async (req, res) => {
  const {
    paymentIntentId,
    cartItems,
    shippingAddressId,
    shipping_cost,
    total_amount,
    merchant_shipping_selections,
  } = req.body;
  const customerId = req.user.id;

  if (!stripe)
    return res.status(500).json({ message: "Stripe configuration error" });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. التحقق من الدفع
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== "succeeded") throw new Error("Payment Failed");

    // 2. إنشاء الطلب
    const [resOrder] = await connection.query(
      `INSERT INTO orders (customer_id, shipping_address_id, total_amount, shipping_cost, status, payment_status, payment_method, stripe_payment_intent_id) 
       VALUES (?, ?, ?, ?, 'pending', 'paid', 'card', ?)`,
      [
        customerId,
        shippingAddressId,
        total_amount,
        shipping_cost,
        paymentIntentId,
      ],
    );
    const orderId = resOrder.insertId;

    // 3. إدراج العناصر
    for (const item of cartItems) {
      let variantId = item.variantId || item.id;
      // معالجة الـ NULL variant للمنتجات البسيطة
      if (!variantId && item.productId) {
        const [v] = await connection.query(
          "SELECT id FROM product_variants WHERE product_id = ? LIMIT 1",
          [item.productId],
        );
        variantId = v[0]?.id;
      }

      await connection.query(
        "INSERT INTO order_items (order_id, product_id, product_variant_id, quantity, price) VALUES (?, ?, ?, ?, ?)",
        [orderId, item.productId, variantId, item.quantity, item.price],
      );

      // تحديث المخزون
      if (variantId) {
        await connection.query(
          "UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
          [item.quantity, variantId],
        );
      }
    }

    // 4. حفظ خيارات الشحن
    if (merchant_shipping_selections?.length > 0) {
      const values = merchant_shipping_selections.map((s) => [
        orderId,
        s.merchant_id,
        s.shipping_option_id,
      ]);
      await connection.query(
        "INSERT INTO order_shipping_selections (order_id, merchant_id, shipping_option_id) VALUES ?",
        [values],
      );
    }

    // 5. 🔥 تسجيل الأرباح المعلقة فوراً (لأن الدفع تم)
    await calculateAndRegisterEarnings(orderId, connection);

    // 6. إشعار
    await connection.query(
      "INSERT INTO notifications (user_id, type, message, link) VALUES (?, 'ORDER_CREATED', ?, ?)",
      [
        customerId,
        `Order #${orderId} Confirmed`,
        `/dashboard/my-orders/${orderId}`,
      ],
    );

    await connection.commit();
    res.status(201).json({ message: "Order Created Successfully", orderId });
  } catch (error) {
    await connection.rollback();
    console.error("Card Order Error:", error);
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
});

/**
 * @desc    تحديث حالة الطلب (وهنا نعالج COD)
 */
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // جلب معلومات الطلب الحالية
    const [[order]] = await connection.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [id],
    );
    if (!order) {
      await connection.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    // تحديث الحالة
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      id,
    ]);

    // 🔥 المنطق المالي للدفع عند الاستلام (COD)
    // إذا كان الطلب COD وتحول إلى Completed، والمال لم يُسجل بعد (earnings_cleared = 0)
    // نقوم بتسجيل الأرباح الآن كـ "معلق" (Pending)
    if (
      order.payment_method === "cod" &&
      status === "completed" &&
      !order.earnings_cleared
    ) {
      console.log(
        `💰 COD Order #${id} Completed. Registering Pending Earnings...`,
      );

      // 1. حساب وتسجيل الأرباح (ستنزل Pending)
      await calculateAndRegisterEarnings(id, connection);

      // 2. تحديث حالة الدفع في الطلب لكي لا نكرر العملية
      await connection.query(
        "UPDATE orders SET payment_status = 'paid', earnings_cleared = 1 WHERE id = ?",
        [id],
      );
    }

    // إشعارات...
    const [[userInfo]] = await connection.query(
      "SELECT customer_id FROM orders WHERE id = ?",
      [id],
    );
    if (userInfo) {
      await connection.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES (?, 'ORDER_UPDATE', ?, ?)",
        [
          userInfo.customer_id,
          `Order #${id} is now ${status}`,
          `/orders/${id}`,
        ],
      );
    }

    await connection.commit();
    res.json({ message: `Order status updated to ${status}` });
  } catch (error) {
    await connection.rollback();
    console.error("Update Status Error:", error);
    res.status(500).json({ message: "Failed to update status" });
  } finally {
    connection.release();
  }
});
