// backend/controllers/orderController.js

const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates"); // 👈 استيراد القوالب

// ===================================================================================
//  HELPER FUNCTIONS 🛠️
// ===================================================================================

/**
 * @private
 * @desc    تحديث المخزون + إرسال تنبيهات انخفاض المخزون
 */
const updateStockLevels = async (item, connection) => {
  // 1. تحديث مخزون التاجر
  await connection.query(
    "UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
    [item.quantity, item.id]
  );

  // فحص مستوى مخزون التاجر بعد التحديث
  const [[variant]] = await connection.query(
    `SELECT pv.stock_quantity, p.name, u.email, u.name as userName 
     FROM product_variants pv 
     JOIN products p ON pv.product_id = p.id 
     JOIN users u ON p.merchant_id = u.id 
     WHERE pv.id = ?`,
    [item.id]
  );

  if (variant && variant.stock_quantity <= 5) {
    sendEmail({
      to: variant.email,
      subject: `تنبيه: مخزون منخفض لـ ${variant.name}`,
      html: templates.lowStockWarning(
        variant.userName,
        variant.name,
        variant.stock_quantity
      ),
    }).catch(console.error);
  }

  // 2. التحقق من الدروبشيبينغ (للمورد)
  const [[link]] = await connection.query(
    "SELECT supplier_variant_id FROM dropship_links WHERE merchant_variant_id = ?",
    [item.id]
  );

  if (link && link.supplier_variant_id) {
    await connection.query(
      "UPDATE supplier_product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
      [item.quantity, link.supplier_variant_id]
    );

    // فحص مستوى مخزون المورد
    const [[supplierVariant]] = await connection.query(
      `SELECT spv.stock_quantity, sp.name, u.email, u.name as userName 
         FROM supplier_product_variants spv 
         JOIN supplier_products sp ON spv.product_id = sp.id 
         JOIN users u ON sp.supplier_id = u.id 
         WHERE spv.id = ?`,
      [link.supplier_variant_id]
    );

    if (supplierVariant && supplierVariant.stock_quantity <= 5) {
      sendEmail({
        to: supplierVariant.email,
        subject: `تنبيه: مخزون منخفض لـ ${supplierVariant.name}`,
        html: templates.lowStockWarning(
          supplierVariant.userName,
          supplierVariant.name,
          supplierVariant.stock_quantity
        ),
      }).catch(console.error);
    }
  }
};

/**
 * @private
 * @desc    تسجيل المنتجات وتحديث المخزون وتحديد الموردين للإشعار
 */
const processOrderItems = async (orderId, items, connection) => {
  const suppliersToNotify = new Map(); // لتجميع منتجات كل مورد

  for (const item of items) {
    // 1. إدراج العنصر
    await connection.query(
      "INSERT INTO order_items (order_id, product_id, product_variant_id, quantity, price) VALUES (?, ?, ?, ?, ?)",
      [orderId, item.productId, item.id, item.quantity, item.price]
    );

    // 2. تحديث المخزون
    await updateStockLevels(item, connection);

    // 3. التحقق هل المنتج للمورد؟ (لأجل الإشعار)
    const [[productInfo]] = await connection.query(
      `SELECT sp.supplier_id, u.email, u.name 
         FROM dropship_links dl
         JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
         JOIN supplier_products sp ON spv.product_id = sp.id
         JOIN users u ON sp.supplier_id = u.id
         WHERE dl.merchant_variant_id = ?`,
      [item.id]
    );

    if (productInfo) {
      const { supplier_id, email, name } = productInfo;
      if (!suppliersToNotify.has(supplier_id)) {
        suppliersToNotify.set(supplier_id, { email, name, items: [] });
      }
      suppliersToNotify.get(supplier_id).items.push(item.name);
    }
  }

  return suppliersToNotify; // إرجاع القائمة لإرسال الإيميلات لاحقاً
};

/**
 * @private
 * @desc    حساب وتسجيل الأرباح (للتاجر والمورد والمنصة).
 */
const calculateAndRecordEarnings = async (orderId, connection) => {
  // 1. جلب نسب العمولة
  const [settingsRows] = await connection.query(
    "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('commission_rate', 'shipping_commission_rate')"
  );
  const settings = settingsRows.reduce((acc, row) => {
    acc[row.setting_key] = parseFloat(row.setting_value);
    return acc;
  }, {});

  const commissionRate = (settings.commission_rate || 10) / 100;
  const shippingCommissionRate =
    (settings.shipping_commission_rate || 10) / 100;

  // 2. جلب منتجات الطلب
  const [items] = await connection.query(
    `SELECT
        oi.quantity, oi.price, p.merchant_id,
        spv.cost_price, sp.supplier_id
     FROM order_items oi
     JOIN product_variants pv ON oi.product_variant_id = pv.id
     JOIN products p ON pv.product_id = p.id
     LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
     LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
     LEFT JOIN supplier_products sp ON spv.product_id = sp.id
     WHERE oi.order_id = ?`,
    [orderId]
  );

  const earningsMap = new Map();
  let primaryOwnerId = null;

  for (const item of items) {
    const isDropshipping = !!item.supplier_id;

    if (isDropshipping) {
      primaryOwnerId = item.supplier_id;
      const sellingPrice = Number(item.price) * Number(item.quantity);
      const costPrice = Number(item.cost_price) * Number(item.quantity);

      // ربح التاجر
      const merchantProfit = sellingPrice - costPrice;
      if (merchantProfit > 0) {
        earningsMap.set(
          item.merchant_id,
          (earningsMap.get(item.merchant_id) || 0) + merchantProfit
        );
      }

      // عمولة المنصة وربح المورد
      const platformCommissionOnCost = costPrice * commissionRate;
      const supplierEarningFromProduct = costPrice - platformCommissionOnCost;
      if (supplierEarningFromProduct > 0) {
        earningsMap.set(
          item.supplier_id,
          (earningsMap.get(item.supplier_id) || 0) + supplierEarningFromProduct
        );
      }
    } else {
      primaryOwnerId = item.merchant_id;
      const saleAmount = Number(item.price) * Number(item.quantity);
      const platformCommission = saleAmount * commissionRate;
      const merchantEarning = saleAmount - platformCommission;

      if (merchantEarning > 0) {
        earningsMap.set(
          item.merchant_id,
          (earningsMap.get(item.merchant_id) || 0) + merchantEarning
        );
      }
    }
  }

  // 3. أرباح الشحن
  const [[order]] = await connection.query(
    "SELECT shipping_cost FROM orders WHERE id = ?",
    [orderId]
  );
  const shippingCost = Number(order.shipping_cost) || 0;

  if (shippingCost > 0 && primaryOwnerId) {
    const platformShippingCommission = shippingCost * shippingCommissionRate;
    const netShippingEarning = shippingCost - platformShippingCommission;
    if (netShippingEarning > 0) {
      earningsMap.set(
        primaryOwnerId,
        (earningsMap.get(primaryOwnerId) || 0) + netShippingEarning
      );
    }
  }

  // 4. تسجيل المعاملات
  for (const [userId, amount] of earningsMap.entries()) {
    if (amount > 0) {
      await connection.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, status, related_entity_type, related_entity_id, description) 
         VALUES (?, ?, 'earning', 'pending_clearance', 'order', ?, ?)`,
        [userId, amount.toFixed(2), orderId, `أرباح من الطلب رقم #${orderId}`]
      );
    }
  }
};
/**
 * @private
 * @desc    الدالة الجوهرية لإنشاء الطلبات (مع فصل طلبات الدروبشيبينغ عن طلبات التاجر)
 */
exports.createOrderInternal = async (orderPayload) => {
  const {
    customerId,
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
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
      [customerId]
    );

    // =========================================================================
    // ✅ 1. (جديد) معالجة العروض الخاطفة: التحقق من الكمية وتحديث العداد
    // =========================================================================
    for (const item of cartItems) {
      // نبحث عما إذا كان هذا المنتج (Variant) جزءاً من عرض خاطف "نشط حالياً"
      const [flashSaleInfo] = await connection.query(
        `SELECT fsp.id, fsp.sold_quantity, fsp.total_quantity, fsp.flash_price 
         FROM flash_sale_products fsp
         JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
         WHERE fsp.variant_id = ? 
           AND fsp.status = 'accepted'
           AND fs.is_active = 1 
           AND NOW() BETWEEN fs.start_time AND fs.end_time
         FOR UPDATE`, // نستخدم FOR UPDATE لمنع التضارب في اللحظة نفسها
        [item.id] // item.id هو variant_id
      );

      // إذا وجدنا أن المنتج جزء من عرض نشط
      if (flashSaleInfo.length > 0) {
        const flashItem = flashSaleInfo[0];

        // التحقق: هل الكمية المطلوبة ستتجاوز الكمية المخصصة للعرض؟
        if (flashItem.sold_quantity + item.quantity > flashItem.total_quantity) {
          throw new Error(
            `عذراً، الكمية المتاحة في العرض الخاطف للمنتج ${item.name} قد نفذت أو غير كافية.`
          );
        }

        // تحديث: زيادة الكمية المباعة في جدول العروض
        await connection.query(
          "UPDATE flash_sale_products SET sold_quantity = sold_quantity + ? WHERE id = ?",
          [item.quantity, flashItem.id]
        );
      }
    }
    // =========================================================================

    // 2. جلب تفاصيل المنتجات والموردين (كما هو في كودك الأصلي)
    const variantIds = cartItems.map((item) => item.id);

    const [variantsInfo] = await connection.query(
      `SELECT 
          pv.id as variant_id, 
          p.merchant_id, 
          sp.supplier_id 
       FROM product_variants pv
       JOIN products p ON pv.product_id = p.id
       LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
       LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
       LEFT JOIN supplier_products sp ON spv.product_id = sp.id
       WHERE pv.id IN (?)`,
      [variantIds]
    );

    // إنشاء خريطة لبيانات كل منتج
    const variantDetailsMap = {};
    variantsInfo.forEach((v) => {
      variantDetailsMap[v.variant_id] = {
        merchant_id: v.merchant_id,
        supplier_id: v.supplier_id || null,
      };
    });

    // 3. تجميع المنتجات (فصل الدروبشيبينغ عن العادي)
    const ordersMap = new Map();

    for (const item of cartItems) {
      const details = variantDetailsMap[item.id];
      if (!details) throw new Error(`Product Variant ${item.id} not found.`);

      const groupKey = `${details.merchant_id}_${details.supplier_id}`;

      if (!ordersMap.has(groupKey)) {
        ordersMap.set(groupKey, {
          merchantId: details.merchant_id,
          supplierId: details.supplier_id,
          items: [],
          merchantTotal: 0,
        });
      }

      const group = ordersMap.get(groupKey);
      group.items.push(item);
      group.merchantTotal += Number(item.price) * item.quantity;
    }

    // 4. إنشاء الطلبات في جدول Orders
    for (const [groupKey, group] of ordersMap.entries()) {
      let shippingCost = 0;
      let shippingCompanyId = null;

      if (merchant_shipping_selections && Array.isArray(merchant_shipping_selections)) {
        const selection = merchant_shipping_selections.find(
          (s) => String(s.merchant_id) === String(group.merchantId)
        );
        if (selection) {
          const [[company]] = await connection.query(
            "SELECT id, shipping_cost FROM shipping_companies WHERE id = ?",
            [selection.shipping_option_id]
          );
          if (company) {
            shippingCost = Number(company.shipping_cost);
            shippingCompanyId = company.id;
          }
        }
      }

      const orderTotal = group.merchantTotal + shippingCost;

      const [orderResult] = await connection.query(
        `INSERT INTO orders (customer_id, status, payment_status, payment_method, total_amount, shipping_address_id, shipping_company_id, shipping_cost, stripe_session_id) 
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          paymentStatus,
          paymentMethod,
          orderTotal,
          shippingAddressId,
          shippingCompanyId,
          shippingCost,
          stripe_session_id,
        ]
      );

      const orderId = orderResult.insertId;
      createdOrderIds.push(orderId);

      // معالجة العناصر وإضافتها لجدول order_items
      const suppliersToNotify = await processOrderItems(
        orderId,
        group.items,
        connection
      );

      // حساب الأرباح
      await calculateAndRecordEarnings(orderId, connection);

      // --- إرسال الإشعارات ---
      const [[merchant]] = await connection.query(
        "SELECT email, name FROM users WHERE id = ?",
        [group.merchantId]
      );

      if (merchant) {
        const notificationType = group.supplierId ? "DROPSHIP_SALE" : "NEW_ORDER";
        const notificationMsg = group.supplierId
          ? `تم بيع منتج دروبشيبينغ (طلب #${orderId})`
          : `طلب جديد للشحن رقم #${orderId}`;

        await connection.query(
          "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
          [
            group.merchantId,
            notificationType,
            "bell",
            notificationMsg,
            `/dashboard/orders/${orderId}`,
          ]
        );

        emailsToSend.push({
          to: merchant.email,
          subject: `طلب جديد #${orderId} - لينورا`,
          html: templates.newOrderForMerchant(
            merchant.name,
            orderId,
            group.items.map((i) => i.name)
          ),
        });
      }

      for (const [supplierId, data] of suppliersToNotify.entries()) {
        await connection.query(
          "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
          [
            supplierId,
            "NEW_DROPSHIP_ORDER",
            "package",
            `طلب توريد جديد رقم #${orderId}`,
            `/dashboard/supplier/orders`,
          ]
        );
        emailsToSend.push({
          to: data.email,
          subject: `📦 طلب توريد جديد #${orderId}`,
          html: templates.newOrderForSupplier(data.name, orderId, data.items),
        });
      }

      if (customer) {
        emailsToSend.push({
          to: customer.email,
          subject: `تأكيد الطلب #${orderId}`,
          html: templates.orderConfirmation(
            customer.name,
            orderId,
            orderTotal.toFixed(2),
            group.items
          ),
        });
      }
    }

    await connection.commit();
    Promise.allSettled(emailsToSend.map((email) => sendEmail(email))).catch(
      console.error
    );

    return createdOrderIds;
  } catch (error) {
    await connection.rollback();
    console.error("Internal order creation failed:", error);
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * @desc    إنشاء طلب جديد للدفع عند الاستلام (COD)
 * @route   POST /api/orders/create-cod
 * @access  Private
 */
exports.createCodOrder = asyncHandler(async (req, res) => {
  const {
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost,
  } = req.body;
  const customerId = req.user.id;

  if (!cartItems || cartItems.length === 0 || !shippingAddressId) {
    return res.status(400).json({ message: "البيانات غير كاملة." });
  }

  const orderPayload = {
    customerId,
    cartItems,
    shippingAddressId,
    merchant_shipping_selections, // استخدام الهيكل الجديد
    shipping_cost,
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    stripe_session_id: null,
  };

  try {
    const orderId = await exports.createOrderInternal(orderPayload);
    res.status(201).json({ message: "تم إنشاء الطلب بنجاح", orderId });
  } catch (error) {
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء الطلب." });
  }
});

/**
 * @desc    إنشاء طلب بعد الدفع الناجح عبر Stripe Intent (Card)
 * @route   POST /api/orders/create-from-intent
 * @access  Private
 */
exports.createOrderFromIntent = asyncHandler(async (req, res) => {
  const {
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost,
    paymentIntentId,
  } = req.body;

  const customerId = req.user.id;

  if (
    !cartItems ||
    cartItems.length === 0 ||
    !shippingAddressId ||
    !paymentIntentId
  ) {
    return res
      .status(400)
      .json({ message: "البيانات غير كاملة لإنشاء الطلب." });
  }

  const orderPayload = {
    customerId,
    cartItems,
    shippingAddressId,
    merchant_shipping_selections,
    shipping_cost,
    paymentMethod: "card",
    paymentStatus: "paid", // مدفوع لأن الـ Intent نجح
    stripe_session_id: paymentIntentId,
  };

  try {
    const orderId = await exports.createOrderInternal(orderPayload);
    res.status(201).json({ message: "تم إنشاء الطلب بنجاح", orderId });
  } catch (error) {
    console.error("Create Order From Intent Error:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء الطلب." });
  }
});

/**
 * @desc    تحديث حالة الطلب (من قبل التاجر)
 * @route   PUT /api/orders/:id/status
 * @access  Private/Merchant
 */
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  const { status } = req.body;
  const requestingUserId = req.user.id;

  const validStatuses = ["processing", "shipped", "completed", "cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "حالة الطلب غير صالحة." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. التحقق من الصلاحية (أن التاجر يملك هذا الطلب)
    const [itemsForAuth] = await connection.query(
      `SELECT 
            p.merchant_id,
            sp.supplier_id
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
         LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
         LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
         LEFT JOIN supplier_products sp ON spv.product_id = sp.id
         WHERE oi.order_id = ?`,
      [orderId]
    );

    if (itemsForAuth.length === 0) {
      return res.status(404).json({ message: "الطلب غير موجود." });
    }

    const isAuthorized = itemsForAuth.some(
      (item) =>
        item.merchant_id === requestingUserId ||
        item.supplier_id === requestingUserId
    );

    // التحقق من الدروبشيبينغ (اختياري حسب سياسة عملك)
    const isDropshipOrder = itemsForAuth.some((item) => !!item.supplier_id);
    const isUserSupplier = itemsForAuth.some(
      (item) => item.supplier_id === requestingUserId
    );

    if (!isAuthorized) {
      await connection.rollback();
      return res
        .status(403)
        .json({ message: "لا تملك صلاحية تعديل هذا الطلب." });
    }

    // إذا كنت تريد منع التاجر من تحديث حالة طلبات الدروبشيبينغ:
    if (isDropshipOrder && !isUserSupplier) {
      await connection.rollback();
      return res.status(403).json({
        message:
          "لا يمكن للتاجر تحديث حالة طلب دروبشيبينغ. يجب على المورد القيام بذلك.",
      });
    }

    // 2. تحديث الحالة
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      orderId,
    ]);

    // 3. (اختياري) تحرير الأرباح عند الاكتمال
    if (status === "completed") {
      // يمكنك إضافة منطق تحويل الأرباح من 'pending' إلى 'cleared' هنا إذا لم يكن يتم تلقائياً بمرور الوقت
    }

    // 4. إشعار العميل (DB + Email)
    const [[orderInfo]] = await connection.query(
      "SELECT o.customer_id, u.email, u.name FROM orders o JOIN users u ON o.customer_id = u.id WHERE o.id = ?",
      [orderId]
    );

    if (orderInfo) {
      const statusTranslations = {
        processing: "قيد التنفيذ",
        shipped: "تم الشحن",
        completed: "مكتمل",
        cancelled: "ملغي",
      };
      const message = `تم تحديث حالة طلبك رقم #${orderId} إلى: ${
        statusTranslations[status] || status
      }.`;

      // إشعار الموقع
      await connection.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          orderInfo.customer_id,
          "ORDER_STATUS_UPDATE",
          "truck",
          message,
          `/dashboard/my-orders/${orderId}`,
        ]
      );

      // إشعار الإيميل (خارج الـ Transaction، لكن يتم تحضيره هنا)
      sendEmail({
        to: orderInfo.email,
        subject: `تحديث حالة الطلب #${orderId} - لينورا`,
        html: templates.orderStatusUpdate(orderInfo.name, orderId, status),
      }).catch(console.error);
    }

    await connection.commit();
    res.status(200).json({ message: `تم تحديث حالة الطلب بنجاح.` });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating order status:", error);
    res.status(500).json({ message: "فشل في تحديث حالة الطلب." });
  } finally {
    if (connection) connection.release();
  }
});
