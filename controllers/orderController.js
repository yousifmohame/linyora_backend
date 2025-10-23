// linora-platform/backend/controllers/orderController.js

const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
const sendEmail = require("../utils/emailService");

// ===================================================================================
//
//  HELPER FUNCTIONS 🛠️
//
// ===================================================================================

/**
 * @private
 * @desc    تحديث مخزون المنتج لدى التاجر والمورد (في حالة الدروبشيبينغ).
 */
const updateStockLevels = async (item, connection) => {
  await connection.query(
    "UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
    [item.quantity, item.id]
  );

  const [[link]] = await connection.query(
    "SELECT supplier_variant_id FROM dropship_links WHERE merchant_variant_id = ?",
    [item.id]
  );

  if (link && link.supplier_variant_id) {
    await connection.query(
      "UPDATE supplier_product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?",
      [item.quantity, link.supplier_variant_id]
    );
  }
};

/**
 * @private
 * @desc    تسجيل منتجات الطلب، تحديث المخزون، وإرسال الإشعارات.
 */
const processOrderItems = async (orderId, cartItems, connection) => {
  const merchantsToNotify = new Map();

  for (const item of cartItems) {
    await connection.query(
      "INSERT INTO order_items (order_id, product_id, product_variant_id, quantity, price) VALUES (?, ?, ?, ?, ?)",
      [orderId, item.productId, item.id, item.quantity, item.price]
    );
    await updateStockLevels(item, connection);

    const [[merchantInfo]] = await connection.query(
      `SELECT p.merchant_id, u.email as merchant_email
             FROM products p JOIN users u ON p.merchant_id = u.id
             WHERE p.id = ?`,
      [item.productId]
    );

    if (merchantInfo) {
      const { merchant_id, merchant_email } = merchantInfo;
      if (!merchantsToNotify.has(merchant_id)) {
        merchantsToNotify.set(merchant_id, {
          email: merchant_email,
          items: [],
        });
      }
      merchantsToNotify.get(merchant_id).items.push(item.name);
    }
  }

  for (const [merchantId, data] of merchantsToNotify.entries()) {
    const message = `لقد استلمت طلبًا جديدًا برقم #${orderId} يحتوي على: ${data.items.join(
      ", "
    )}.`;
    await connection.query(
      "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
      [merchantId, "NEW_ORDER", "bell", message, `/dashboard/orders/${orderId}`]
    );
    await sendEmail({
      to: data.email,
      subject: `🎉 طلب جديد على منصة لينورا برقم #${orderId}`,
      html: `<div dir="rtl"><h3>لديك طلب جديد!</h3><p>${message}</p><p><a href="${process.env.FRONTEND_URL}/dashboard/orders/${orderId}">اضغط هنا لعرض تفاصيل الطلب</a></p></div>`,
    });
  }
};

/**
 * @private
 * @desc    حساب وتسجيل الأرباح المعلقة مع تتبع مفصل للعمليات.
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

      // 1. حساب ربح التاجر الصافي
      const merchantProfit = sellingPrice - costPrice;
      if (merchantProfit > 0) {
        earningsMap.set(
          item.merchant_id,
          (earningsMap.get(item.merchant_id) || 0) + merchantProfit
        );
      }

      // 2. حساب عمولة المنصة من سعر تكلفة المورد
      const platformCommissionOnCost = costPrice * commissionRate;

      // 3. حساب ربح المورد الصافي من المنتج
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

  // 3. حساب وتوزيع أرباح الشحن
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
  } else {
    console.log(`  - No shipping cost or no primary owner to assign it to.`);
  }

  for (const [userId, amount] of earningsMap.entries()) {
    if (amount > 0) {
      await connection.query(
        `INSERT INTO wallet_transactions (user_id, amount, type, status, related_entity_type, related_entity_id, description) VALUES (?, ?, 'earning', 'pending_clearance', 'order', ?, ?)`,
        [userId, amount.toFixed(2), orderId, `أرباح من الطلب رقم #${orderId}`]
      );
    }
  }
};

/**
 * @private
 * @desc    Core internal function to create an order. Can be called from anywhere.
 * @param   {object} orderPayload - Contains all necessary order data.
 * @returns {number} The ID of the newly created order.
 */
exports.createOrderInternal = async (orderPayload) => {
  const {
    customerId,
    cartItems,
    shippingAddressId,
    shipping_company_id,
    shipping_cost,
    paymentMethod,
    paymentStatus,
    stripe_session_id,
  } = orderPayload;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const itemsTotal = cartItems.reduce(
      (total, item) => total + Number(item.price) * item.quantity,
      0
    );
    const totalAmount = itemsTotal + Number(shipping_cost);

    const [orderResult] = await connection.query(
      `INSERT INTO orders (customer_id, status, payment_status, payment_method, total_amount, shipping_address_id, shipping_company_id, shipping_cost, stripe_session_id) 
               VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        paymentStatus,
        paymentMethod,
        totalAmount,
        shippingAddressId,
        shipping_company_id,
        shipping_cost,
        stripe_session_id,
      ]
    );
    const orderId = orderResult.insertId;

    await processOrderItems(orderId, cartItems, connection);
    await calculateAndRecordEarnings(orderId, connection);

    await connection.commit();
    return orderId;
  } catch (error) {
    await connection.rollback();
    console.error("Internal order creation failed:", error);
    throw error; // Re-throw the error to be caught by the caller
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
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } =
    req.body;
  const customerId = req.user.id;

  if (
    !cartItems ||
    cartItems.length === 0 ||
    !shippingAddressId ||
    !shipping_company_id
  ) {
    return res
      .status(400)
      .json({ message: "البيانات غير كاملة لإنشاء طلب الدفع عند الاستلام." });
  }

  const orderPayload = {
    customerId,
    cartItems,
    shippingAddressId,
    shipping_company_id,
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

    if (isDropshipOrder && !isUserSupplier) {
      await connection.rollback();
      return res.status(403).json({
        message:
          "لا يمكن للتاجر تحديث حالة طلب دروبشيبينغ. يجب على المورد القيام بذلك.",
      });
    }

    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      orderId,
    ]);

    const [[orderInfo]] = await connection.query(
      "SELECT customer_id FROM orders WHERE id = ?",
      [orderId]
    );
    if (orderInfo) {
      const message = `تم تحديث حالة طلبك رقم #${orderId} إلى: ${status}.`;
      await connection.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          orderInfo.customer_id,
          "ORDER_STATUS_UPDATE",
          "bell",
          message,
          `/dashboard/my-orders/${orderId}`,
        ]
      );
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
