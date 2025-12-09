// controllers/adminController.js
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");
const asyncHandler = require("express-async-handler");
const templates = require("../utils/emailTemplates");

exports.getDashboardAnalytics = async (req, res) => {
  try {
    const [
      userCounts,
      generalCounts,
      salesData,
      platformSettings, // ✨ 1. جلب إعدادات العمولات
    ] = await Promise.all([
      pool.query(`
                SELECT 
                    SUM(CASE WHEN role_id = 2 THEN 1 ELSE 0 END) as merchants,
                    SUM(CASE WHEN role_id = 3 THEN 1 ELSE 0 END) as models,
                    SUM(CASE WHEN role_id = 4 THEN 1 ELSE 0 END) as influencers,
                    SUM(CASE WHEN role_id = 5 THEN 1 ELSE 0 END) as customers
                FROM users
            `),
      pool.query(`
                SELECT
                    (SELECT COUNT(*) FROM products) as totalProducts,
                    (SELECT COUNT(*) FROM orders) as totalOrders,
                    (SELECT COUNT(*) FROM shipping_companies) as totalShipping,
                    (SELECT COUNT(*) FROM agreements) as totalAgreements
            `),
      pool.query(`
                SELECT 
                    DATE(o.created_at) as date,
                    SUM(o.total_amount) as sales
                FROM orders o
                WHERE o.status = 'completed' AND o.created_at >= NOW() - INTERVAL 30 DAY
                GROUP BY DATE(o.created_at)
                ORDER BY date ASC
            `),
      // ✨ 2. جلب نسب العمولات من قاعدة البيانات
      pool.query(
        "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('commission_rate', 'shipping_commission_rate')"
      ),
    ]);

    // --- ✨ 3. حساب إجمالي الإيرادات والأرباح ---
    const [totalRevenueResult] = await pool.query(
      "SELECT SUM(total_amount) as totalRevenue FROM orders WHERE status = 'completed'"
    );
    const totalRevenue = totalRevenueResult[0].totalRevenue || 0;

    const commissionRate =
      parseFloat(
        platformSettings[0].find((s) => s.setting_key === "commission_rate")
          ?.setting_value
      ) || 0;
    const shippingCommissionRate =
      parseFloat(
        platformSettings[0].find(
          (s) => s.setting_key === "shipping_commission_rate"
        )?.setting_value
      ) || 0;

    const [commissions] = await pool.query(
      `SELECT 
                SUM((o.total_amount - o.shipping_cost) * (? / 100)) as product_commission,
                SUM(o.shipping_cost * (? / 100)) as shipping_commission
             FROM orders o
             WHERE o.status = 'completed'`,
      [commissionRate, shippingCommissionRate]
    );

    const platformEarnings =
      (commissions[0].product_commission || 0) +
      (commissions[0].shipping_commission || 0);

    const dailySales = salesData[0];
    const weeklySales = dailySales.slice(-7);
    const monthlySales = dailySales;

    const analytics = {
      userCounts: userCounts[0][0],
      generalCounts: generalCounts[0][0],
      weeklySales,
      monthlySales,
      platformRevenue: totalRevenue, // <-- ✨ إضافة الإيرادات
      platformEarnings: platformEarnings, // <-- ✨ إضافة الأرباح
    };

    res.status(200).json(analytics);
  } catch (error) {
    console.error("Error fetching dashboard analytics:", error);
    res.status(500).json({ message: "Server error while fetching analytics." });
  }
};

// [GET] جلب جميع المستخدمين مع أدوارهم
exports.getAllUsers = async (req, res) => {
  try {
    const query = `
            SELECT 
                u.id, u.name, u.email, u.created_at, u.is_banned, r.name as roleName, r.id as roleId
            FROM users u
            JOIN roles r ON u.role_id = r.id
            ORDER BY u.created_at DESC;
        `;
    const [users] = await pool.query(query);
    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "خطأ في جلب بيانات المستخدمين" });
  }
};

// [PUT] تحديث بيانات مستخدم (تعديل الدور أو الحظر)
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { role_id, is_banned } = req.body;

  // منع المشرف من حظر نفسه
  if (Number(id) === req.user.id && is_banned) {
    return res.status(400).json({ message: "لا يمكنك حظر حسابك الخاص." });
  }

  try {
    await pool.query(
      "UPDATE users SET role_id = ?, is_banned = ? WHERE id = ?",
      [role_id, is_banned, id]
    );
    res.status(200).json({ message: "تم تحديث المستخدم بنجاح!" });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ message: "خطأ في تحديث المستخدم." });
  }
};

/**
 * @desc    حذف مستخدم من قبل المشرف (Admin)
 * @route   DELETE /api/admin/users/:id
 * @access  Private (Admin)
 */
exports.deleteUser = asyncHandler(async (req, res) => {
  const userIdToDelete = req.params.id;

  // لا تسمح للمشرف بحذف نفسه
  if (req.user.id === parseInt(userIdToDelete, 10)) {
    return res.status(400).json({ message: "لا يمكنك حذف حسابك الخاص." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. التحقق من وجود المستخدم
    const [[user]] = await connection.query(
      "SELECT id FROM users WHERE id = ?",
      [userIdToDelete]
    );
    if (!user) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: "المستخدم غير موجود." });
    }

    // --- ✅ [FIX] حذف السجلات المرتبطة أولاً ---
    // يجب إضافة حذف لجميع الجداول التي قد تحتوي على user_id كمفتاح أجنبي

    // 2. حذف الاشتراكات المرتبطة
    await connection.query("DELETE FROM user_subscriptions WHERE user_id = ?", [
      userIdToDelete,
    ]);

    // 3. حذف الإشعارات المرتبطة
    await connection.query("DELETE FROM notifications WHERE user_id = ?", [
      userIdToDelete,
    ]);

    // 4. حذف العناوين المرتبطة
    await connection.query("DELETE FROM addresses WHERE user_id = ?", [
      userIdToDelete,
    ]);

    // 5. حذف سجلات المحفظة والمعاملات (هام!)
    await connection.query(
      "DELETE FROM wallet_transactions WHERE user_id = ?",
      [userIdToDelete]
    );
    // 6. حذف السجلات الخاصة بأدوار المستخدم (تاجر، مودل، مورد)
    //    (افترض أن هذه الجداول تحتوي على user_id)
    //    !! يجب إضافة حذف للمنتجات والمتغيرات إذا كان المستخدم تاجرًا !!
    //    !! يجب إضافة حذف للعروض والباقات إذا كان المستخدم مودل !!
    //    !! يجب إضافة حذف لمنتجات المورد إذا كان موردًا !!
    //    مثال (قد تحتاج لتعديله حسب هيكل جداولك):
    await connection.query("DELETE FROM products WHERE merchant_id = ?", [
      userIdToDelete,
    ]); // Requires handling variants, etc. first
    await connection.query("DELETE FROM service_packages WHERE user_id = ?", [
      userIdToDelete,
    ]); // Requires handling tiers first
    await connection.query(
      "DELETE FROM supplier_products WHERE supplier_id = ?",
      [userIdToDelete]
    ); // Requires handling variants first

    // --- [هام جدًا] ---
    // عملية حذف المنتجات/العروض تتطلب منطقًا مشابهًا لما فعلناه سابقًا (حذف الاعتماديات أولاً).
    // قد يكون من الأفضل عدم حذف هذه البيانات مباشرة، بل وضع علامة "محذوف" على المستخدم
    // أو نقل البيانات لأرشيف بدلاً من حذفها نهائيًا للحفاظ على سجلات المبيعات/الاتفاقيات السابقة.
    // الحل الحالي يحذف فقط البيانات الأساسية للمستخدم.

    // 7. حذف المستخدم الرئيسي
    await connection.query("DELETE FROM users WHERE id = ?", [userIdToDelete]);

    // 8. إكمال المعاملة
    await connection.commit();
    res.status(200).json({ message: "تم حذف المستخدم بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error deleting user:", error);
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      res
        .status(400)
        .json({
          message:
            "لا يمكن حذف المستخدم لوجود بيانات مرتبطة به لم يتم حذفها (مثل المنتجات أو الطلبات النشطة).",
          details: error.sqlMessage,
        });
    } else {
      res
        .status(500)
        .json({ message: "حدث خطأ غير متوقع أثناء حذف المستخدم." });
    }
  } finally {
    connection.release();
  }
});

exports.getAllAgreements = async (req, res) => {
  try {
    // ✨ Updated query to use new package tables
    const query = `
        SELECT 
            a.id, 
            a.status, 
            a.created_at,
            merchant.name as merchantName,
            model.name as modelName,
            p.name as productName,
            sp.title as packageTitle,
            pt.tier_name as tierName,
            pt.price as tierPrice
        FROM agreements a
        JOIN users merchant ON a.merchant_id = merchant.id
        JOIN users model ON a.model_id = model.id
        JOIN products p ON a.product_id = p.id
        JOIN package_tiers pt ON a.package_tier_id = pt.id
        JOIN service_packages sp ON pt.package_id = sp.id
        ORDER BY a.created_at DESC;
    `;
    const [agreements] = await pool.query(query);
    res.status(200).json(agreements);
  } catch (error) {
    console.error("Error fetching all agreements for admin:", error);
    res.status(500).json({ message: "خطأ في جلب بيانات الاتفاقات" });
  }
};
// [GET] جلب الإحصائيات العامة للمنصة
// controllers/adminController.js

exports.getPlatformStats = async (req, res) => {
  try {
    // استعلاماتنا لم تتغير
    const queries = [
      pool.query("SELECT COUNT(*) as count FROM users"),
      pool.query("SELECT COUNT(*) as count FROM users WHERE role_id = 2"),
      pool.query(
        "SELECT COUNT(*) as count FROM orders WHERE status = 'completed'"
      ),
      pool.query(
        "SELECT SUM(oi.price * oi.quantity) as total FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.status = 'completed'"
      ),
      pool.query(
        "SELECT COUNT(*) as count FROM agreements WHERE status IN ('accepted', 'completed')"
      ),
    ];

    // ✨ طريقة التفكيك المصححة
    const results = await Promise.all(queries);

    // ✨ استخراج النتائج بشكل صحيح
    const totalUsers = results[0][0][0].count;
    const totalMerchants = results[1][0][0].count;
    const totalOrders = results[2][0][0].count;
    const totalSales = results[3][0][0].total;
    const totalAgreements = results[4][0][0].count;

    const stats = {
      totalUsers: totalUsers,
      totalMerchants: totalMerchants,
      totalOrders: totalOrders,
      totalSales: totalSales || 0, // لا نزال نحافظ على || 0 كإجراء وقائي
      totalAgreements: totalAgreements,
    };

    res.status(200).json(stats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "خطأ في جلب إحصائيات المنصة" });
  }
};

// [GET] جلب جميع إعدادات المنصة
exports.getSettings = async (req, res) => {
  try {
    const [settings] = await pool.query(
      "SELECT setting_key, setting_value FROM platform_settings"
    );
    // تحويل المصفوفة إلى كائن لسهولة الاستخدام في الواجهة الأمامية
    const settingsObj = settings.reduce((obj, item) => {
      obj[item.setting_key] = item.setting_value;
      return obj;
    }, {});
    res.status(200).json(settingsObj);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب الإعدادات" });
  }
};

// [PUT] تحديث إعدادات المنصة
exports.updateSettings = async (req, res) => {
  const settings = req.body; // Expecting an object like { commission_rate: '15.00' }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const key in settings) {
      await connection.query(
        "UPDATE platform_settings SET setting_value = ? WHERE setting_key = ?",
        [settings[key], key]
      );
    }
    await connection.commit();
    res.status(200).json({ message: "تم تحديث الإعدادات بنجاح!" });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: "خطأ في تحديث الإعدادات" });
  } finally {
    connection.release();
  }
};

exports.getShippingCompanies = async (req, res) => {
  try {
    const [companies] = await pool.query(
      "SELECT * FROM shipping_companies ORDER BY name ASC"
    );
    res.status(200).json(companies);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب شركات الشحن." });
  }
};

// [POST] إضافة شركة شحن جديدة
exports.addShippingCompany = async (req, res) => {
  const { name, api_key, is_active } = req.body;
  try {
    await pool.query(
      "INSERT INTO shipping_companies (name, api_key, is_active) VALUES (?, ?, ?)",
      [name, api_key, is_active]
    );
    res.status(201).json({ message: "تمت إضافة شركة الشحن بنجاح." });
  } catch (error) {
    res.status(500).json({ message: "فشل إضافة شركة الشحن." });
  }
};

// [PUT] تحديث شركة شحن
exports.updateShippingCompany = async (req, res) => {
  const { id } = req.params;
  const { name, api_key, is_active } = req.body;
  try {
    await pool.query(
      "UPDATE shipping_companies SET name = ?, api_key = ?, is_active = ? WHERE id = ?",
      [name, api_key, is_active, id]
    );
    res.status(200).json({ message: "تم تحديث شركة الشحن بنجاح." });
  } catch (error) {
    res.status(500).json({ message: "فشل تحديث شركة الشحن." });
  }
};

// --- ✨ دوال جديدة لإدارة الاشتراكات ---

// [GET] جلب جميع الاشتراكات في المنصة
exports.getAllSubscriptions = asyncHandler(async (req, res) => {
  try {
    // تم تصحيح اسم الجدول إلى 'user_subscriptions'
    // وتم إضافة JOIN مع 'subscription_plans' لجلب اسم وسعر الباقة بشكل ديناميكي
    const [subscriptions] = await pool.query(`
            SELECT 
                us.id, 
                us.status, 
                us.start_date, 
                us.end_date, 
                sp.name as plan_name,  -- اسم الباقة
                sp.price as plan_price, -- سعر الباقة
                u.name as userName, 
                u.email as userEmail
            FROM user_subscriptions us
            JOIN users u ON us.user_id = u.id
            LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
            ORDER BY us.start_date DESC
        `);

    res.status(200).json(subscriptions);
  } catch (error) {
    console.error("Error fetching all subscriptions:", error);
    res.status(500).json({ message: "فشل في جلب الاشتراكات." });
  }
});

exports.getAllPlatformProducts = async (req, res) => {
  try {
    const [products] = await pool.query(`
            SELECT 
                p.id, p.name, p.status, p.brand, u.name as merchantName,
                (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id) as variantCount
            FROM products p
            JOIN users u ON p.merchant_id = u.id
            ORDER BY p.created_at DESC
        `);
    res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching all platform products:", error);
    res.status(500).json({ message: "خطأ في جلب منتجات المنصة." });
  }
};

exports.getAllPlatformOrders = async (req, res) => {
  try {
    const [orders] = await pool.query(`
            SELECT 
                o.id, o.status, o.created_at, u.name as customerName,
                (SELECT SUM(oi.price * oi.quantity) FROM order_items oi WHERE oi.order_id = o.id) as totalAmount
            FROM orders o
            JOIN users u ON o.customer_id = u.id
            ORDER BY o.created_at DESC
        `);
    res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching all platform orders:", error);
    res.status(500).json({ message: "خطأ في جلب طلبات المنصة." });
  }
};

exports.updateProductStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["active", "draft"].includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة." });
  }

  try {
    await pool.query("UPDATE products SET status = ? WHERE id = ?", [
      status,
      id,
    ]);
    res.status(200).json({ message: "تم تحديث حالة المنتج بنجاح." });
  } catch (error) {
    console.error("Error updating product status:", error);
    res.status(500).json({ message: "فشل تحديث حالة المنتج." });
  }
};

// [DELETE] حذف منتج بواسطة المشرفة
exports.deleteProduct = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM products WHERE id = ?", [id]);
    res.status(200).json({ message: "تم حذف المنتج بنجاح." });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ message: "فشل حذف المنتج." });
  }
};

exports.getOrderDetails = async (req, res) => {
  const { id: orderId } = req.params;
  try {
    const [orderDetails] = await pool.query(
      `SELECT o.id, o.status, o.created_at, u.name as customerName, u.email as customerEmail, u.phone_number, u.address 
             FROM orders o 
             JOIN users u ON o.customer_id = u.id 
             WHERE o.id = ?`,
      [orderId]
    );

    if (orderDetails.length === 0) {
      return res.status(404).json({ message: "الطلب غير موجود." });
    }

    const [orderItems] = await pool.query(
      `SELECT p.name as productName, v.color, v.images, oi.quantity, oi.price 
             FROM order_items oi 
             JOIN products p ON oi.product_id = p.id
             LEFT JOIN product_variants v ON oi.product_variant_id = v.id
             WHERE oi.order_id = ?`,
      [orderId]
    );

    // حساب الإجمالي
    const totalAmount = orderItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    res.status(200).json({
      details: { ...orderDetails[0], totalAmount },
      items: orderItems,
    });
  } catch (error) {
    console.error("Error fetching order details for admin:", error);
    res.status(500).json({ message: "خطأ في جلب تفاصيل الطلب." });
  }
};

// --- ✨ دالة جديدة للمشرفة لتحديث حالة أي اتفاق ---

exports.updateAgreementStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = [
    "pending",
    "accepted",
    "rejected",
    "completed",
    "in_dispute",
  ];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة." });
  }

  const connection = await pool.getConnection(); // <-- ✨ نستخدم Connection للـ Transaction

  try {
    await connection.beginTransaction(); // <-- ✨ بدء الـ Transaction

    const [result] = await connection.query(
      "UPDATE agreements SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "لم يتم العثور على الاتفاق." });
    }

    const [agreementDetails] = await connection.query(
      `
            SELECT 
                a.merchant_id, a.model_id, a.stripe_payment_intent_id,
                m.email as merchant_email, mo.email as model_email, 
                o.title as offer_title,
                o.price as offer_price
            FROM agreements a
            JOIN users m ON a.merchant_id = m.id
            JOIN users mo ON a.model_id = mo.id
            JOIN offers o ON a.offer_id = o.id
            WHERE a.id = ?
            `,
      [id]
    );

    // --- ✨ منطق العمولة والمحفظة يبدأ هنا ---
    // --- ✨ منطق سحب المبلغ والمحفظة يبدأ هنا ---
    if (status === "completed" && agreementDetails.length > 0) {
      const { model_id, offer_price, stripe_payment_intent_id } =
        agreementDetails[0];

      // الآن هذا السطر سيعمل بنجاح لأن stripe_payment_intent_id موجود
      if (!stripe_payment_intent_id) {
        throw new Error(
          "Stripe payment intent ID not found for this agreement."
        );
      }

      const stripe = getStripe();
      await stripe.paymentIntents.capture(stripe_payment_intent_id);

      // 2. حساب العمولة وصافي الربح (نفس المنطق السابق)
      const [settings] = await connection.query(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'agreement_commission_rate'"
      );
      const commissionRate = parseFloat(settings[0]?.setting_value) || 0;
      const commissionAmount = (offer_price * commissionRate) / 100;
      const netEarnings = offer_price - commissionAmount;

      // 3. إيداع صافي الربح في محفظة المودل (نفس المنطق السابق)
      const [[modelWallet]] = await connection.query(
        "SELECT id FROM model_wallets WHERE user_id = ?",
        [model_id]
      );
      if (!modelWallet) {
        await connection.query(
          "INSERT INTO model_wallets (user_id) VALUES (?)",
          [model_id]
        );
      }
      await connection.query(
        "UPDATE model_wallets SET pending_clearance = pending_clearance + ? WHERE user_id = ?",
        [netEarnings, model_id]
      );
    }

    // إرسال الإشعارات والإيميلات (لا تغيير هنا)
    if (agreementDetails.length > 0) {
      const {
        merchant_id,
        model_id,
        merchant_email,
        model_email,
        offer_title,
      } = agreementDetails[0];
      const notificationMessage = `قامت الإدارة بتحديث حالة الاتفاق الخاص بالعرض "${offer_title}" إلى: ${status}`;

      // إرسال الإشعارات
      await pool.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
        [
          merchant_id,
          "AGREEMENT_UPDATE",
          notificationMessage,
          "/dashboard/models",
          model_id,
          "AGREEMENT_UPDATE",
          notificationMessage,
          "/dashboard/requests",
        ]
      );

      // إرسال الإيميلات
      const emailSubject = `تحديث إداري بخصوص اتفاق "${offer_title}"`;
      await sendEmail({
        to: merchant_email,
        subject: emailSubject,
        html: `<p>${notificationMessage}</p>`,
      });
      await sendEmail({
        to: model_email,
        subject: emailSubject,
        html: `<p>${notificationMessage}</p>`,
      });
    }

    await connection.commit(); // <-- ✨ تأكيد الـ Transaction
    res.status(200).json({ message: "تم تحديث حالة الاتفاق بنجاح." });
  } catch (error) {
    await connection.rollback(); // <-- ✨ التراجع في حالة حدوث خطأ
    console.error("Admin update agreement status error:", error);
    res.status(500).json({ message: "فشل تحديث حالة الاتفاق." });
  } finally {
    connection.release(); // <-- ✨ تحرير الـ Connection
  }
};

exports.cancelUserSubscription = async (req, res) => {
  const stripe = getStripe();
  const { id } = req.params; // This is the subscription ID from your database
  try {
    const [subResult] = await pool.query(
      "SELECT stripe_subscription_id FROM user_subscriptions WHERE id = ?",
      [id]
    );

    if (subResult.length === 0 || !subResult[0].stripe_subscription_id) {
      return res
        .status(404)
        .json({ message: "No active Stripe subscription found to cancel." });
    }

    const stripeSubscriptionId = subResult[0].stripe_subscription_id;

    // Cancel at the end of the current period in Stripe
    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Update the status in your database
    await pool.query(
      "UPDATE user_subscriptions SET status = 'cancelled' WHERE id = ?",
      [id]
    );

    res.status(200).json({
      message: "Subscription has been set to cancel at the end of the period.",
    });
  } catch (error) {
    console.error("Admin: Error cancelling subscription:", error);
    res.status(500).json({ message: "Failed to cancel subscription." });
  }
};

// [DELETE] Admin deletes a subscription record
exports.deleteUserSubscription = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM user_subscriptions WHERE id = ?", [id]);
    res
      .status(200)
      .json({ message: "Subscription record deleted successfully." });
  } catch (error) {
    console.error("Admin: Error deleting subscription:", error);
    res.status(500).json({ message: "Failed to delete subscription record." });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const [settings] = await pool.query("SELECT * FROM platform_settings");
    // Convert the array of {key, value} pairs into a single object
    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.setting_key] = setting.setting_value;
      return acc;
    }, {});
    res.json(settingsObject);
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    res.status(500).json({ message: "Error fetching settings" });
  }
};

// PUT /api/admin/settings - Updates multiple settings
exports.updateSettings = async (req, res) => {
  const newSettings = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Loop through each setting sent from the frontend
    for (const key in newSettings) {
      if (Object.hasOwnProperty.call(newSettings, key)) {
        const value = newSettings[key];

        // Use INSERT ... ON DUPLICATE KEY UPDATE to simplify logic
        // This will insert a new row if the key doesn't exist, or update it if it does.
        await connection.query(
          `INSERT INTO platform_settings (setting_key, setting_value) 
                     VALUES (?, ?) 
                     ON DUPLICATE KEY UPDATE setting_value = ?`,
          [key, value, value]
        );
      }
    }

    await connection.commit();
    res.status(200).json({ message: "Settings updated successfully" });
  } catch (error) {
    await connection.rollback();
    console.error("Failed to update settings:", error);
    res.status(500).json({ message: "Error updating settings" });
  } finally {
    connection.release();
  }
};

exports.getPendingVerifications = async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, name, email, business_name, created_at FROM users WHERE verification_status = 'pending'"
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch pending verifications." });
  }
};

// @desc    Get details for a single verification
// @route   GET /api/admin/verifications/:id
exports.getVerificationDetails = async (req, res) => {
  try {
    const { id } = req.params;
    // ✨ إضافة social_links و stats إلى الاستعلام
    const [user] = await pool.query(
      "SELECT id, name, email, identity_number, identity_image_url, business_name, business_license_url, social_links, stats FROM users WHERE id = ?",
      [id]
    );
    const [bank] = await pool.query(
      "SELECT account_number, iban, iban_certificate_url FROM merchant_bank_details WHERE user_id = ?",
      [id]
    );

    if (user.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    // ✨ التأكد من أن البيانات هي كائنات JSON وليست نصوص
    const userProfile = user[0];
    userProfile.social_links = userProfile.social_links
      ? JSON.parse(userProfile.social_links)
      : {};
    userProfile.stats = userProfile.stats ? JSON.parse(userProfile.stats) : {};

    res.json({ user: userProfile, bank: bank[0] || {} });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch verification details." });
  }
};

// @desc    Approve or reject a verification
// @route   PUT /api/admin/verifications/:id
exports.reviewVerification = async (req, res) => {
  const { id } = req.params;
  const { status, rejection_reason } = req.body; // status should be 'approved' or 'rejected'

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Invalid status." });
  }
  if (status === "rejected" && !rejection_reason) {
    return res.status(400).json({ message: "Rejection reason is required." });
  }

  try {
    await pool.query(
      "UPDATE users SET verification_status = ?, rejection_reason = ? WHERE id = ?",
      [status, status === "rejected" ? rejection_reason : null, id]
    );

    // --- Send Email Notification ---
    const [user] = await pool.query("SELECT email, name FROM users WHERE id = ?", [id]);
    
    if (user.length > 0) {
      const { email, name } = user[0];
      
      // 1. إشعار داخل الموقع
      const message = status === 'approved' 
        ? "تهانينا! تمت الموافقة على توثيق حسابك." 
        : "عذراً، تم رفض طلب التوثيق. يرجى مراجعة البريد الإلكتروني للتفاصيل.";
        
      await pool.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [id, "VERIFICATION", status === 'approved' ? 'check' : 'x', message, "/dashboard/settings"]
      );

      // 2. إرسال الإيميل بالقالب الجديد
      await sendEmail({
        to: email,
        subject: status === "approved" ? "مبروك! تم توثيق حسابك في لينيورا" : "تحديث بخصوص طلب التوثيق",
        html: templates.verificationResult(name, status, rejection_reason),
      });
    }

    res.json({ message: `Merchant has been ${status}.` });
  } catch (error) {
    res.status(500).json({ message: "Failed to update verification status." });
  }
};

/**
 * @desc    Admin: Get all pending payout requests (merchants AND suppliers)
 * @route   GET /api/admin/payouts
 * @access  Private (Admin)
 */
exports.getAllPayoutRequests = asyncHandler(async (req, res) => {
  try {
    const [requests] = await pool.query(`
            -- Fetch Merchant Payouts
            SELECT 
                pr.id, pr.amount, pr.status, pr.created_at,
                u.id as user_id, u.name, u.email,
                'merchant' as user_type 
            FROM payout_requests pr
            JOIN users u ON pr.merchant_id = u.id
            WHERE pr.status = 'pending'

            UNION ALL

            -- Fetch Supplier Payouts
            SELECT 
                spr.id, spr.amount, spr.status, spr.created_at,
                u.id as user_id, u.name, u.email,
                'supplier' as user_type
            FROM supplier_payout_requests spr
            JOIN users u ON spr.supplier_id = u.id
            WHERE spr.status = 'pending'

            ORDER BY created_at ASC
        `);
    res.json(requests);
  } catch (error) {
    console.error("Error fetching all payout requests:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching payout requests." });
  }
});

/**
 * @desc    Admin: Update the status of any payout request (merchant or supplier)
 * @route   PUT /api/admin/payouts/:id
 * @access  Private (Admin)
 */
exports.updatePayoutRequestStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes, user_type } = req.body; // user_type is crucial!

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Invalid status." });
  }
  if (!["merchant", "supplier"].includes(user_type)) {
    return res.status(400).json({ message: "Invalid user type." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const isMerchant = user_type === "merchant";
    const requestTable = isMerchant
      ? "payout_requests"
      : "supplier_payout_requests";
    const walletTable = isMerchant ? "merchant_wallets" : "supplier_wallets";
    const userIdColumn = isMerchant ? "merchant_id" : "supplier_id";

    // 1. Fetch the specific request to process it
    const [[request]] = await connection.query(
      `SELECT * FROM ${requestTable} WHERE id = ? AND status = "pending" FOR UPDATE`,
      [id]
    );

    if (!request) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "Request not found or already processed." });
    }

    const userId = request[userIdColumn];

    // 2. If rejected, refund the amount to the correct wallet
    if (status === "rejected") {
      await connection.query(
        `UPDATE ${walletTable} SET balance = balance + ? WHERE ${userIdColumn} = ?`,
        [request.amount, userId]
      );
    }

    // 3. Update the request status
    await connection.query(
      `UPDATE ${requestTable} SET status = ?, notes = ? WHERE id = ?`,
      [status, notes, id]
    );

    await connection.commit();

    // --- 🔔 الإشعارات ---
    if (requestInfo) {
        // 1. إشعار الموقع
        const message = `تم ${status === 'approved' ? 'الموافقة على' : 'رفض'} طلب السحب رقم #${id}.`;
        await pool.query(
            "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
            [requestInfo.user_id, "PAYOUT_UPDATE", "wallet", message, "/dashboard/wallet"]
        );

        // 2. إيميل
        sendEmail({
            to: requestInfo.email,
            subject: `تحديث حالة طلب السحب #${id}`,
            html: templates.payoutStatusUpdate(requestInfo.name, requestInfo.amount, status, notes)
        }).catch(console.error);
    }

    res.json({ message: `Request for ${user_type} has been ${status}.` });

    // (Optional: Send email notification to user)
  } catch (error) {
    await connection.rollback();
    console.error(`Error updating ${user_type} payout status:`, error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Admin: Get details for a single payout request (merchant or supplier)
 * @route   GET /api/admin/payouts/:id
 * @access  Private (Admin)
 */
exports.getPayoutRequestDetails = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { user_type } = req.query; // Send user_type as a query parameter from frontend

  if (!["merchant", "supplier"].includes(user_type)) {
    return res.status(400).json({ message: "Invalid user type provided." });
  }

  const isMerchant = user_type === "merchant";
  const requestTable = isMerchant
    ? "payout_requests"
    : "supplier_payout_requests";
  const userIdColumn = isMerchant ? "pr.merchant_id" : "pr.supplier_id";

  try {
    const [details] = await pool.query(
      `SELECT 
                pr.id, pr.amount, pr.status, pr.created_at,
                u.name, u.email, u.phone_number,
                mbd.account_number, mbd.iban, mbd.iban_certificate_url
             FROM ${requestTable} pr
             JOIN users u ON ${userIdColumn} = u.id
             LEFT JOIN merchant_bank_details mbd ON u.id = mbd.user_id
             WHERE pr.id = ?`,
      [id]
    );

    if (details.length === 0) {
      return res.status(404).json({ message: "لم يتم العثور على طلب السحب." });
    }

    res.json({ ...details[0], user_type });
  } catch (error) {
    console.error("Error fetching payout request details:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * @desc    Get all subscription plans
 * @route   GET /api/admin/subscription-plans
 * @access  Admin
 */
exports.getSubscriptionPlans = asyncHandler(async (req, res) => {
  try {
    const [plans] = await pool.query(
      "SELECT * FROM subscription_plans ORDER BY role, price"
    );
    res.json(plans);
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching plans." });
  }
});

/**
 * @desc    Create a new subscription plan
 * @route   POST /api/admin/subscription-plans
 * @access  Admin
 */
exports.createSubscriptionPlan = asyncHandler(async (req, res) => {
  try {
    const {
      role,
      name,
      description,
      price,
      features,
      includes_dropshipping,
      allows_promotion_in_stories, // 🔥 استقبال الحقل الجديد
      is_active,
    } = req.body;

    const valuesToInsert = [
      role,
      name,
      description,
      price,
      JSON.stringify(features || []),
      includes_dropshipping || false,
      allows_promotion_in_stories || false, // 🔥 إضافته للقيم (افتراضي false)
      is_active,
    ];

    // 🔥 تحديث جملة SQL لإضافة العمود الجديد
    const [result] = await pool.query(
      "INSERT INTO subscription_plans (role, name, description, price, features, includes_dropshipping, allows_promotion_in_stories, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      valuesToInsert
    );

    res
      .status(201)
      .json({ message: "تم إنشاء الباقة بنجاح", id: result.insertId });
  } catch (error) {
    console.error("Create Plan Error:", error);
    res.status(500).json({ message: "Server error while creating the plan." });
  }
});

/**
 * @desc    Update a subscription plan
 * @route   PUT /api/admin/subscription-plans/:id
 * @access  Admin
 */
exports.updateSubscriptionPlan = asyncHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      price,
      features,
      includes_dropshipping,
      allows_promotion_in_stories, // 🔥 استقبال الحقل الجديد
      is_active,
    } = req.body;

    const valuesToUpdate = [
      name,
      description,
      price,
      JSON.stringify(features || []),
      includes_dropshipping || false,
      allows_promotion_in_stories || false, // 🔥 إضافته للقيم
      is_active,
      id,
    ];

    // 🔥 تحديث جملة SQL لتعديل العمود الجديد
    const [result] = await pool.query(
      "UPDATE subscription_plans SET name = ?, description = ?, price = ?, features = ?, includes_dropshipping = ?, allows_promotion_in_stories = ?, is_active = ? WHERE id = ?",
      valuesToUpdate
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Plan not found." });
    }

    res.json({ message: "تم تحديث الباقة بنجاح" });
  } catch (error) {
    console.error("Update Plan Error:", error);
    res.status(500).json({ message: "Server error while updating the plan." });
  }
});

/**
 * @desc    Admin: Get all pending payout requests for models
 * @route   GET /api/admin/model-payouts
 * @access  Private (Admin)
 */
exports.getAllModelPayouts = async (req, res) => {
  try {
    // ✨ [الحل] قمنا بتطبيق نفس منطق الـ JOIN من دالة getModelPayoutDetails
    const [requests] = await pool.query(`
        SELECT 
          mpr.id, mpr.amount, mpr.status, mpr.notes, mpr.created_at,
          u.id as user_id, 
          u.name as userName,      
          u.email as userEmail,
          
          -- ✨ إضافة بيانات البنك من الجدول الموحد
          mbd.account_number, 
          mbd.iban, 
          mbd.iban_certificate_url

      FROM model_payout_requests mpr
      JOIN users u ON mpr.user_id = u.id
      LEFT JOIN merchant_bank_details mbd ON u.id = mbd.user_id
      -- WHERE mpr.status = 'pending'
      ORDER BY mpr.created_at DESC
    `);

    res.json(requests);
  } catch (error) {
    console.error("Error fetching all model payout requests:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Admin: Update the status of a model payout request
 * @route   PUT /api/admin/model-payouts/:id
 * @access  Private (Admin)
 */
exports.updateModelPayoutStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body; // 'approved' or 'rejected'

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Status is required." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [payouts] = await connection.query(
      "SELECT * FROM model_payout_requests WHERE id = ? FOR UPDATE",
      [id]
    );
    const payout = payouts[0];

    if (!payout) {
      await connection.rollback();
      return res.status(404).json({ message: "Payout request not found." });
    }

    if (payout.status !== "pending") {
      await connection.rollback();
      return res.status(400).json({ message: "Request already processed." });
    }

    // 1. تحديث الطلب
    await connection.query(
      "UPDATE model_payout_requests SET status = ?, notes = ? WHERE id = ?",
      [status, notes, id]
    );

    // 2. إذا تم الرفض، أعد المال إلى wallet_transactions
    if (status === "rejected") {
      const [txs] = await connection.query(
        "SELECT * FROM wallet_transactions WHERE id = ?",
        [payout.wallet_transaction_id] // هذا هو العمود الذي أضفناه
      );
      const originalTx = txs[0];

      if (originalTx) {
        await connection.query(
          `INSERT INTO wallet_transactions (user_id, amount, type, status, description, related_entity_id) 
           VALUES (?, ?, 'payout_refund', 'cleared', ?, ?)`,
          [
            payout.user_id,
            Math.abs(originalTx.amount), // إرجاع المبلغ الموجب
            `إلغاء طلب السحب المرفوض #${id}`,
            payout.id,
          ]
        );
      }
    }

    // 3. إذا تمت الموافقة، لا نفعل شيئاً

    await connection.commit();

    // --- 🔔 الإشعارات ---
    if (payout) {
        const message = `تم ${status === 'approved' ? 'الموافقة على' : 'رفض'} طلب السحب رقم #${id}.`;
        
        await pool.query(
            "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
            [payout.user_id, "PAYOUT_UPDATE", "wallet", message, "/dashboard/models/wallet"]
        );

        sendEmail({
            to: payout.email,
            subject: `تحديث حالة طلب السحب #${id}`,
            html: templates.payoutStatusUpdate(payout.name, payout.amount, status, notes)
        }).catch(console.error);
    }
    
    res.json({ message: `Payout ${status}.` });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating model payout:", error);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Admin: Get details for a single model payout request
 * @route   GET /api/admin/model-payouts/:id
 * @access  Private (Admin)
 */
exports.getModelPayoutDetails = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    // قمنا بعمل JOIN مع users لجلب اسم الموديل
    // و LEFT JOIN مع merchant_bank_details لجلب بيانات البنك
    // (نفترض أن الموديل تستخدم نفس جدول التجار للبيانات البنكية)
    const [details] = await pool.query(
      `SELECT 
                mpr.id, mpr.amount, mpr.status, mpr.notes, mpr.created_at,
                u.name as userName, u.email as userEmail, u.phone_number,
                mbd.account_number, mbd.iban, mbd.iban_certificate_url, mbd.bank_name 
             FROM model_payout_requests mpr
             JOIN users u ON mpr.user_id = u.id
             LEFT JOIN merchant_bank_details mbd ON u.id = mbd.user_id
             WHERE mpr.id = ?`,
      [id]
    );

    if (details.length === 0) {
      return res.status(404).json({ message: "لم يتم العثور على طلب السحب." });
    }

    res.json(details[0]);
  } catch (error) {
    console.error("Error fetching model payout request details:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// [GET] جلب جميع باقات الترويج
exports.getAllPromotionTiers = asyncHandler(async (req, res) => {
  const [tiers] = await pool.query(
    "SELECT id, name, duration_days, price, is_active FROM promotion_tiers ORDER BY created_at DESC"
  );
  const formattedTiers = tiers.map((t) => ({ ...t, is_active: !!t.is_active })); // تحويل 0/1 إلى boolean
  res.status(200).json(formattedTiers);
});

// [POST] إنشاء باقة ترويج جديدة
exports.createPromotionTier = asyncHandler(async (req, res) => {
  // ✨ Added priority and badge_color
  const { name, duration_days, price, priority, badge_color } = req.body;
  const [result] = await pool.query(
    "INSERT INTO promotion_tiers (name, duration_days, price, priority, badge_color) VALUES (?, ?, ?, ?, ?)",
    [name, duration_days, price, priority || 0, badge_color || "#cccccc"]
  );
  res
    .status(201)
    .json({
      id: result.insertId,
      name,
      duration_days,
      price,
      priority,
      badge_color,
      is_active: true,
    });
});

// [PUT] تحديث باقة ترويج
exports.updatePromotionTier = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // ✨ Added priority and badge_color
  const { name, duration_days, price, is_active, priority, badge_color } =
    req.body;

  const fields = [];
  const values = [];
  if (name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (duration_days !== undefined) {
    fields.push("duration_days = ?");
    values.push(duration_days);
  }
  if (price !== undefined) {
    fields.push("price = ?");
    values.push(price);
  }
  if (is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(is_active);
  }
  // ✨ Add new fields to the update query
  if (priority !== undefined) {
    fields.push("priority = ?");
    values.push(priority);
  }
  if (badge_color !== undefined) {
    fields.push("badge_color = ?");
    values.push(badge_color);
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: "No data to update." });
  }

  values.push(id);
  await pool.query(
    `UPDATE promotion_tiers SET ${fields.join(", ")} WHERE id = ?`,
    values
  );
  res.status(200).json({ message: "تم تحديث الباقة بنجاح." });
});

// [GET] جلب جميع طلبات الترويج المعلقة
exports.getPromotionRequests = asyncHandler(async (req, res) => {
  const query = `
        SELECT
            pp.id, pp.status, pp.created_at,
            p.name as productName, u.name as merchantName,
            pt.name as tierName, pt.price
        FROM product_promotions pp
        JOIN products p ON pp.product_id = p.id
        JOIN users u ON pp.merchant_id = u.id
        JOIN promotion_tiers pt ON pp.promotion_tier_id = pt.id
        WHERE pp.status = 'pending_approval'
        ORDER BY pp.created_at ASC
    `;
  const [requests] = await pool.query(query);
  res.status(200).json(requests);
});

// [PUT] الموافقة على طلب ترويج وتفعيله
exports.approvePromotionRequest = asyncHandler(async (req, res) => {
  const { id: promotionId } = req.params;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[request]] = await connection.query(
      `SELECT pp.*, pt.duration_days FROM product_promotions pp 
             JOIN promotion_tiers pt ON pp.promotion_tier_id = pt.id 
             WHERE pp.id = ? AND pp.status = 'pending_approval'`,
      [promotionId]
    );

    if (!request) {
      throw new Error("الطلب غير موجود أو تمت معالجته مسبقًا.");
    }

    await connection.query(
      "UPDATE product_promotions SET status = 'active', start_date = NOW(), end_date = NOW() + INTERVAL ? DAY WHERE id = ?",
      [request.duration_days, promotionId]
    );

    await connection.commit();
    res.status(200).json({ message: "تمت الموافقة على الطلب وتفعيله بنجاح." });
  } catch (error) {
    await connection.rollback();
    res
      .status(500)
      .json({ message: error.message || "فشل في الموافقة على الطلب." });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Admin: Get all products from all merchants
 * @route   GET /api/admin/products
 * @access  Private/Admin
 */
exports.getAllProducts = asyncHandler(async (req, res) => {
  // استعلام معقد لجلب كل البيانات المطلوبة بكفاءة
  const query = `
        SELECT 
        p.id, p.name, p.brand, p.status, p.created_at AS createdAt,
        u.name AS merchantName,
        (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id) AS variantCount,
        (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) AS price,
        (SELECT SUM(stock_quantity) FROM product_variants WHERE product_id = p.id) AS inventory,
        (SELECT GROUP_CONCAT(c.name SEPARATOR ', ') FROM product_categories pc JOIN categories c ON pc.category_id = c.id WHERE pc.product_id = p.id) as category,
        
        -- 👇 هذا هو منطق جلب الصورة الذي اكتشفناه 👇
        (
            SELECT svi.image_url
            FROM supplier_variant_images svi
            JOIN supplier_product_variants spv ON svi.variant_id = spv.id
            JOIN dropship_links dl ON spv.id = dl.supplier_variant_id
            WHERE dl.merchant_variant_id = (
                SELECT pv_inner.id
                FROM product_variants pv_inner
                WHERE pv_inner.product_id = p.id
                ORDER BY pv_inner.price ASC
                LIMIT 1
            )
            ORDER BY svi.sort_order ASC
            LIMIT 1
        ) as image_from_supplier

        FROM products p
        JOIN users u ON p.merchant_id = u.id
        ORDER BY p.created_at DESC;
    `;
  const [products] = await pool.query(query);
  res.status(200).json(products);
});

/**
 * @desc    Admin: Update a product's status
 * @route   PUT /api/admin/products/:id
 * @access  Private/Admin
 */
exports.updateProductStatusByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["active", "draft", "archived"].includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة." });
  }

  const [result] = await pool.query(
    "UPDATE products SET status = ? WHERE id = ?",
    [status, id]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "المنتج غير موجود." });
  }

  res.status(200).json({ message: "تم تحديث حالة المنتج بنجاح." });
});

/**
 * @desc    Admin: Delete a product
 * @route   DELETE /api/admin/products/:id
 * @access  Private/Admin
 */
exports.deleteProductByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // استخدام transaction لضمان الحذف الآمن
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // حذف السجلات المرتبطة (احترازي)
    await connection.query(
      "DELETE FROM product_categories WHERE product_id = ?",
      [id]
    );
    await connection.query("DELETE FROM product_reviews WHERE product_id = ?", [
      id,
    ]);
    await connection.query(
      "DELETE FROM product_promotions WHERE product_id = ?",
      [id]
    );

    // حذف المنتج نفسه (سيؤدي إلى حذف المتغيرات المرتبطة تلقائياً بسبب ON DELETE CASCADE)
    const [result] = await connection.query(
      "DELETE FROM products WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      throw new Error("المنتج غير موجود.");
    }

    await connection.commit();
    res.status(200).json({ message: "تم حذف المنتج بنجاح." });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message || "فشل في حذف المنتج." });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Admin: Get all conversations on the platform
 * @route   GET /api/admin/conversations
 * @access  Private/Admin
 */
exports.adminGetAllConversations = asyncHandler(async (req, res) => {
  // جلب جميع المحادثات مع أسماء المشاركين وآخر رسالة
  const query = `
    SELECT 
      c.id as conversation_id,
      c.updated_at,
      m.id as merchant_id,
      m.name as merchant_name,
      m.profile_picture_url as merchant_avatar,
      mdl.id as model_id,
      mdl.name as model_name,
      mdl.profile_picture_url as model_avatar,
      (SELECT body FROM messages msg WHERE msg.conversation_id = c.id ORDER BY msg.created_at DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id AND msg.is_read = 0 AND msg.receiver_id = 1) as unread_admin_count 
      -- (ملاحظة: هذا يتطلب تعديلاً على نظام "is_read" ليناسب الأدمن)
    FROM conversations c
    JOIN users m ON c.merchant_id = m.id
    JOIN users mdl ON c.model_id = mdl.id
    ORDER BY c.updated_at DESC
  `;
  const [conversations] = await pool.query(query);
  res.json(conversations);
});

/**
 * @desc    Admin: Get all messages for a specific conversation
 * @route   GET /api/admin/conversations/:conversationId
 * @access  Private/Admin
 */
exports.adminGetMessagesForConversation = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;

  // لا نحتاج للتحقق من هوية المستخدم، الأدمن يمكنه رؤية كل شيء
  const query = `
    SELECT 
      m.*,
      u.name as sender_name,
      u.profile_picture_url as sender_avatar
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at ASC
  `;
  const [messages] = await pool.query(query, [conversationId]);
  res.json(messages);
});
