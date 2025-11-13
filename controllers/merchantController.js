// controllers/merchantController.js
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");
const asyncHandler = require("express-async-handler");

exports.submitVerification = async (req, res) => {
  const merchantId = req.user.id;
  const { identity_number, business_name, account_number, iban } = req.body;
  const files = req.files;

  if (
    !identity_number ||
    !files.identity_image ||
    !account_number ||
    !iban ||
    !files.iban_certificate
  ) {
    return res
      .status(400)
      .json({ message: "الرجاء تقديم جميع الحقول والملفات المطلوبة." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE users SET 
                identity_number = ?, business_name = ?, 
                identity_image_url = ?, business_license_url = ?, 
                verification_status = 'pending' 
             WHERE id = ?`,
      [
        identity_number,
        business_name,
        files.identity_image[0].path,
        files.business_license ? files.business_license[0].path : null,
        merchantId,
      ]
    );

    await connection.query(
      `INSERT INTO merchant_bank_details (user_id, account_number, iban, iban_certificate_url) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
                account_number = VALUES(account_number), 
                iban = VALUES(iban), 
                iban_certificate_url = VALUES(iban_certificate_url)`,
      [merchantId, account_number, iban, files.iban_certificate[0].path]
    );

    await connection.commit();
    res.status(200).json({
      message: "تم تقديم بيانات التوثيق بنجاح وهي الآن قيد المراجعة.",
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error submitting verification:", error);
    res.status(500).json({ message: "فشل في تقديم بيانات التوثيق." });
  } finally {
    connection.release();
  }
};

exports.getDashboardData = async (req, res) => {
  const merchantId = req.user.id;

  try {
    const [
      salesResult,
      productsResult,
      recentOrdersResult,
      weeklySalesResult,
      monthlySalesResult,
    ] = await Promise.all([
      pool.query(
        `SELECT SUM(oi.price * oi.quantity) as totalSales
                 FROM order_items oi
                 JOIN products p ON oi.product_id = p.id
                 JOIN orders o ON oi.order_id = o.id
                 WHERE p.merchant_id = ? AND o.status = 'completed'`,
        [merchantId]
      ),
      pool.query(
        `SELECT 
                    COUNT(*) as totalProducts,
                    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activeProducts
                 FROM products WHERE merchant_id = ?`,
        [merchantId]
      ),
      pool.query(
        `SELECT o.id, u.name as customerName, o.status, SUM(oi.price * oi.quantity) as total
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.order_id
                 JOIN users u ON o.customer_id = u.id
                 WHERE oi.product_id IN (SELECT id FROM products WHERE merchant_id = ?)
                 GROUP BY o.id
                 ORDER BY o.created_at DESC
                 LIMIT 4`,
        [merchantId]
      ),
      pool.query(
        `SELECT DATE(o.created_at) as date, SUM(oi.price * oi.quantity) as sales
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.order_id
                 JOIN products p ON oi.product_id = p.id
                 WHERE p.merchant_id = ? AND o.status = 'completed' AND o.created_at >= NOW() - INTERVAL 7 DAY
                 GROUP BY DATE(o.created_at) ORDER BY date ASC`,
        [merchantId]
      ),
      pool.query(
        `SELECT DATE(o.created_at) as date, SUM(oi.price * oi.quantity) as sales
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.order_id
                 JOIN products p ON oi.product_id = p.id
                 WHERE p.merchant_id = ? AND o.status = 'completed' AND o.created_at >= NOW() - INTERVAL 30 DAY
                 GROUP BY DATE(o.created_at) ORDER BY date ASC`,
        [merchantId]
      ),
    ]);

    let reviewsData = { averageRating: 0, totalReviews: 0 };
    try {
      const [reviewsResult] = await pool.query(
        `SELECT AVG(rating) as averageRating, COUNT(*) as totalReviews FROM product_reviews pr JOIN products p ON pr.product_id = p.id WHERE p.merchant_id = ?`,
        [merchantId]
      );
      if (reviewsResult.length > 0) {
        reviewsData = {
          averageRating: reviewsResult[0].averageRating || 0,
          totalReviews: reviewsResult[0].totalReviews || 0,
        };
      }
    } catch (e) {
      console.log("Could not fetch reviews, table likely doesn't exist yet.");
    }

    let viewsData = { monthlyViews: 0 };
    try {
      const [viewsResult] = await pool.query(
        `SELECT COUNT(*) as monthlyViews FROM product_views pv JOIN products p ON pv.product_id = p.id WHERE p.merchant_id = ? AND MONTH(pv.viewed_at) = MONTH(CURDATE()) AND YEAR(pv.viewed_at) = YEAR(CURDATE())`,
        [merchantId]
      );
      if (viewsResult.length > 0) {
        viewsData = {
          monthlyViews: viewsResult[0].monthlyViews || 0,
        };
      }
    } catch (e) {
      console.log(
        "Could not fetch product views, table likely doesn't exist yet."
      );
    }

    const dashboardData = {
      totalSales: salesResult[0][0].totalSales || 0,
      totalProducts: productsResult[0][0].totalProducts || 0,
      activeProducts: productsResult[0][0].activeProducts || 0,
      recentOrders: recentOrdersResult[0],
      averageRating: reviewsData.averageRating,
      totalReviews: reviewsData.totalReviews,
      monthlyViews: viewsData.monthlyViews,
      weeklySales: weeklySalesResult[0],
      monthlySales: monthlySalesResult[0],
    };

    res.status(200).json(dashboardData);
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching dashboard data." });
  }
};

// [POST] إنشاء منتج جديد
exports.createProduct = async (req, res) => {
  // ✨ تم التعديل هنا: إضافة status
  const { name, description, brand, status, variants, categoryIds } = req.body;
  const merchantId = req.user.id;

  if (!name || !variants || variants.length === 0) {
    return res
      .status(400)
      .json({ message: "Product name and at least one variant are required." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // ✨ تم التعديل هنا: إضافة status إلى الاستعلام
    const [productResult] = await connection.query(
      "INSERT INTO products (merchant_id, name, description, brand, status) VALUES (?, ?, ?, ?, ?)",
      [merchantId, name, description, brand, status || "draft"] // القيمة الافتراضية هي 'draft'
    );
    const productId = productResult.insertId;

    // --- ✨ الجزء الجديد: ربط المنتج بالفئات ---
    if (categoryIds && categoryIds.length > 0) {
      const categoryLinks = categoryIds.map((catId) => [productId, catId]);
      await connection.query(
        "INSERT INTO product_categories (product_id, category_id) VALUES ?",
        [categoryLinks]
      );
    }

    for (const variant of variants) {
      const { color, price, compare_at_price, stock_quantity, images, sku } =
        variant;
      const finalSku =
        sku ||
        `${name.substring(0, 3).toUpperCase()}-${color
          .substring(0, 2)
          .toUpperCase()}-${Date.now()}`;

      await connection.query(
        "INSERT INTO product_variants (product_id, color, price, compare_at_price, stock_quantity, sku, images) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          productId,
          color,
          price,
          compare_at_price || null,
          stock_quantity,
          finalSku,
          JSON.stringify(images || []),
        ]
      );
    }

    await connection.commit();
    res.status(201).json({
      message: "Product and its variants were created successfully!",
      productId,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Failed to create product with variants:", error);
    res.status(500).json({ message: "Error creating the product." });
  } finally {
    connection.release();
  }
};

exports.getMerchantProducts = asyncHandler(async (req, res) => {
  const merchantId = req.user.id;

  // ✅ [FIX] The DATEDIFF function has been added to the query.
  const productQuery = `
        SELECT 
            p.*,
            pp.end_date as promotion_ends_at,
            pt.name as promotion_tier_name,
            DATEDIFF(pp.end_date, NOW()) as promotion_days_left 
        FROM products p
        LEFT JOIN product_promotions pp ON p.id = pp.product_id AND pp.status = 'active' AND pp.end_date > NOW()
        LEFT JOIN promotion_tiers pt ON pp.promotion_tier_id = pt.id
        WHERE p.merchant_id = ?
        GROUP BY p.id
        ORDER BY p.created_at DESC
    `;
  const [products] = await pool.query(productQuery, [merchantId]);

  if (products.length === 0) {
    return res.json([]);
  }

  const productIds = products.map((p) => p.id);

  const [variantsResult, categoriesResult] = await Promise.all([
    pool.query("SELECT * FROM product_variants WHERE product_id IN (?)", [
      productIds,
    ]),
    pool.query(
      "SELECT product_id, category_id FROM product_categories WHERE product_id IN (?)",
      [productIds]
    ),
  ]);

  const variants = variantsResult[0];
  const productCategories = categoriesResult[0];

  const variantsMap = new Map();
  variants.forEach((variant) => {
    const items = variantsMap.get(variant.product_id) || [];
    items.push({
      ...variant,
      images:
        typeof variant.images === "string"
          ? JSON.parse(variant.images)
          : variant.images || [],
    });
    variantsMap.set(variant.product_id, items);
  });

  const categoryMap = new Map();
  productCategories.forEach((row) => {
    const items = categoryMap.get(row.product_id) || [];
    items.push(row.category_id);
    categoryMap.set(row.product_id, items);
  });

  const productsWithDetails = products.map((product) => ({
    ...product,
    variants: variantsMap.get(product.id) || [],
    categoryIds: categoryMap.get(product.id) || [],
  }));

  res.json(productsWithDetails);
});

// [PUT] Update a product and its variants
exports.updateProduct = asyncHandler(async (req, res) => {
  const { id: productId } = req.params;
  const merchantId = req.user.id;
  const { name, brand, description, variants, categoryIds } = req.body;

  console.log("[DEBUG] Updating product:", { productId, merchantId });
  console.log(
    "[DEBUG] Request body - name:",
    name,
    "brand:",
    brand,
    "description length:",
    description?.length
  );
  console.log("[DEBUG] Variants count:", variants?.length || 0);
  console.log("[DEBUG] Category IDs:", categoryIds);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Verify the product belongs to the merchant
    const [[productCheck]] = await connection.query(
      "SELECT id FROM products WHERE id = ? AND merchant_id = ?",
      [productId, merchantId]
    );
    if (!productCheck) {
      console.log("[DEBUG] Product not found or unauthorized access attempt.");
      await connection.rollback();
      return res.status(404).json({
        message: "Product not found or you do not have permission to edit it.",
      });
    }

    // 2. Check if this is a dropshipping product
    const [links] = await connection.query(
      `SELECT dl.id FROM dropship_links dl
             JOIN product_variants pv ON dl.merchant_variant_id = pv.id
             WHERE pv.product_id = ?`,
      [productId]
    );
    const isDropshippingProduct = links.length > 0;
    console.log("[DEBUG] Is dropshipping product?", isDropshippingProduct);

    if (isDropshippingProduct) {
      console.log(
        "[DEBUG] Processing as DROP-SHIPPING product (limited update)"
      );

      // a) Update main product details
      await connection.query(
        "UPDATE products SET name = ?, brand = ?, description = ? WHERE id = ?",
        [name, brand, description, productId]
      );

      // b) Update only price & compare_at_price for variants
      if (variants && Array.isArray(variants) && variants.length > 0) {
        for (const variant of variants) {
          if (
            variant.id &&
            (variant.price !== undefined ||
              variant.compare_at_price !== undefined)
          ) {
            console.log(
              `[DEBUG] Updating dropship variant ID ${variant.id}: price=${variant.price}, compare_at_price=${variant.compare_at_price}`
            );
            await connection.query(
              "UPDATE product_variants SET price = ?, compare_at_price = ? WHERE id = ? AND product_id = ?",
              [
                variant.price,
                variant.compare_at_price !== undefined
                  ? variant.compare_at_price
                  : null,
                variant.id,
                productId,
              ]
            );
          } else {
            console.log(
              `[DEBUG] Skipping variant ${variant.id} — no price or compare_at_price provided.`
            );
          }
        }
      } else {
        console.log(
          "[DEBUG] No variants provided for dropshipping product update."
        );
      }

      await connection.commit();
      console.log("[DEBUG] Dropshipping product updated successfully.");
      res
        .status(200)
        .json({ message: "Dropshipping product updated successfully." });
    } else {
      console.log(
        "[DEBUG] Processing as REGULAR merchant product (full update)"
      );

      // a) Update main product details
      await connection.query(
        "UPDATE products SET name = ?, brand = ?, description = ? WHERE id = ?",
        [name, brand, description, productId]
      );

      // b) Full variant sync
      const [existingVariants] = await connection.query(
        "SELECT id FROM product_variants WHERE product_id = ?",
        [productId]
      );
      const existingVariantIds = existingVariants.map((v) => v.id);
      const submittedVariantIds = variants.map((v) => v.id).filter(Boolean);

      console.log("[DEBUG] Existing variant IDs:", existingVariantIds);
      console.log("[DEBUG] Submitted variant IDs:", submittedVariantIds);

      const variantsToDelete = existingVariantIds.filter(
        (id) => !submittedVariantIds.includes(id)
      );
      if (variantsToDelete.length > 0) {
        console.log("[DEBUG] Deleting variants:", variantsToDelete);
        await connection.query("DELETE FROM product_variants WHERE id IN (?)", [
          variantsToDelete,
        ]);
      }

      for (const variant of variants) {
        const imagesJSON = JSON.stringify(variant.images || []);
        if (variant.id) {
          console.log(`[DEBUG] Updating existing variant ${variant.id}`);
          await connection.query(
            "UPDATE product_variants SET color = ?, price = ?, compare_at_price = ?, stock_quantity = ?, sku = ?, images = ? WHERE id = ?",
            [
              variant.color,
              variant.price,
              variant.compare_at_price || null,
              variant.stock_quantity,
              variant.sku,
              imagesJSON,
              variant.id,
            ]
          );
        } else {
          console.log("[DEBUG] Inserting new variant");
          await connection.query(
            "INSERT INTO product_variants (product_id, color, price, compare_at_price, stock_quantity, sku, images) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              productId,
              variant.color,
              variant.price,
              variant.compare_at_price || null,
              variant.stock_quantity,
              variant.sku,
              imagesJSON,
            ]
          );
        }
      }

      // c) Category sync
      console.log("[DEBUG] Syncing categories...");
      await connection.query(
        "DELETE FROM product_categories WHERE product_id = ?",
        [productId]
      );
      if (categoryIds && categoryIds.length > 0) {
        const categoryValues = categoryIds.map((catId) => [productId, catId]);
        console.log("[DEBUG] Inserting category associations:", categoryValues);
        await connection.query(
          "INSERT INTO product_categories (product_id, category_id) VALUES ?",
          [categoryValues]
        );
      }

      await connection.commit();
      console.log("[DEBUG] Regular product updated successfully.");
      res.status(200).json({ message: "Product updated successfully." });
    }
  } catch (error) {
    await connection.rollback();
    console.error("[ERROR] Failed to update product:", error);
    res.status(500).json({ message: "Failed to update product." });
  } finally {
    console.log("[DEBUG] Releasing database connection.");
    connection.release();
  }
});

// [GET] جلب جميع الطلبات التي تحتوي على منتجات التاجر
exports.getOrders = async (req, res) => {
  try {
    const merchantId = req.user.id;

    const query = `
      SELECT 
        o.id AS orderId,
        o.status AS orderStatus,
        o.created_at AS orderDate,
        c.name AS customerName,
        c.email AS customerEmail,
        SUM(oi.price * oi.quantity) AS totalAmount,
        GROUP_CONCAT(p.name SEPARATOR ', ') AS products
      FROM orders o
      JOIN users c ON o.customer_id = c.id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE p.merchant_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC;
    `;

    const [orders] = await pool.query(query, [merchantId]);

    res.status(200).json(orders);
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    res.status(500).json({ message: "خطأ في جلب الطلبات" });
  }
};

// [GET] جلب تفاصيل طلب واحد
exports.getOrderDetails = async (req, res) => {
  const { id: orderId } = req.params;
  const merchantId = req.user.id;

  try {
    // فحص أمني: التأكد من أن هذا الطلب يحتوي على منتج واحد على الأقل يخص التاجر
    const [authCheck] = await pool.query(
      `SELECT o.id FROM orders o JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id WHERE o.id = ? AND p.merchant_id = ? LIMIT 1`,
      [orderId, merchantId]
    );

    if (authCheck.length === 0) {
      return res
        .status(403)
        .json({ message: "لا تملك صلاحية الوصول لهذا الطلب" });
    }

    // جلب تفاصيل الطلب الكاملة
    const [orderDetails] = await pool.query(
      `SELECT o.id, o.status, o.created_at, u.name as customerName, u.email as customerEmail FROM orders o JOIN users u ON o.customer_id = u.id WHERE o.id = ?`,
      [orderId]
    );

    const [orderItems] = await pool.query(
      `SELECT p.name, oi.quantity, oi.price FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`,
      [orderId]
    );

    res.status(200).json({ details: orderDetails[0], items: orderItems });
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب تفاصيل الطلب" });
  }
};

// [PUT] تحديث حالة الطلب
/**
 * @desc    Merchant: Update status of one of their orders
 * @route   PUT /api/merchants/orders/:id/status
 * @access  Private/Merchant
 */
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  const { status } = req.body;
  const merchantId = req.user.id;

  if (!status) {
    return res.status(400).json({ message: "الحالة الجديدة مطلوبة" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // --- الخطوة 1: التحقق من أن التاجر يملك الطلب وأنه ليس طلب دروبشيبينغ ---
    const [orderItems] = await pool.query(
      `SELECT p.source_supplier_product_id 
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = ? AND p.merchant_id = ?`,
      [orderId, merchantId]
    );

    // إذا لم يجد أي منتجات للتاجر في هذا الطلب
    if (orderItems.length === 0) {
      return res
        .status(403)
        .json({ message: "لا تملك صلاحية تعديل هذا الطلب" });
    }

    // إذا كان أي منتج في الطلب هو منتج دروبشيبينغ
    if (orderItems.some((item) => item.source_supplier_product_id !== null)) {
      return res.status(403).json({
        message:
          "لا يمكنك تحديث حالة هذا الطلب. المورد هو المسؤول عن تحديث الحالة.",
      });
    }

    // --- الخطوة 2: تحديث حالة الطلب ---
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      orderId,
    ]);

    // --- الخطوة 3: إذا اكتمل الطلب، انقل الأرباح إلى رصيد التاجر ---
    if (status === "completed") {
      // هذا الجزء اختياري ولكنه مهم جدًا لإكمال الدورة المالية
      // يفترض أن الأرباح كانت في 'pending_clearance'
      // ملاحظة: يجب تعديل هذا الاستعلام ليناسب منطق حساب الأرباح الدقيق الخاص بك
      await connection.query(
        `UPDATE merchant_wallets w
                 JOIN (
                    SELECT p.merchant_id, SUM(oi.price * oi.quantity) as total
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = ?
                    GROUP BY p.merchant_id
                 ) AS order_earnings ON w.merchant_id = order_earnings.merchant_id
                 SET 
                    w.balance = w.balance + (order_earnings.total * (1 - (SELECT setting_value FROM platform_settings WHERE setting_key = 'commission_rate') / 100)),
                    w.pending_clearance = w.pending_clearance - (order_earnings.total * (1 - (SELECT setting_value FROM platform_settings WHERE setting_key = 'commission_rate') / 100))
                 WHERE w.merchant_id = ?`,
        [orderId, merchantId]
      );
    }

    // --- الخطوة 4: إرسال الإشعارات للعميل ---
    const { customer_id, customer_email } = orderItems[0];
    const statusTranslations = {
      processing: "قيد التنفيذ",
      shipped: "تم الشحن",
      completed: "مكتمل",
      cancelled: "ملغي",
    };
    const statusInArabic = statusTranslations[status] || status;
    const notificationMessage = `تم تحديث حالة طلبك رقم #${orderId} إلى: ${statusInArabic}.`;

    await connection.query(
      "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
      [
        customer_id,
        "ORDER_STATUS_UPDATE",
        notificationMessage,
        `/dashboard/my-orders/${orderId}`,
      ]
    );

    await sendEmail({
      to: customer_email,
      subject: `تحديث بخصوص طلبك رقم #${orderId}`,
      html: `<div dir="rtl"><h3>مرحباً،</h3><p>${notificationMessage}</p><p>يمكنك متابعة تفاصيل طلبك من خلال لوحة التحكم الخاصة بك.</p></div>`,
    });

    await connection.commit();
    res
      .status(200)
      .json({ message: "تم تحديث حالة الطلب وإرسال إشعار للعميل بنجاح!" });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating order status:", error);
    res.status(500).json({ message: "خطأ في تحديث حالة الطلب" });
  } finally {
    if (connection) connection.release();
  }
});
// --- ✨ دالة جديدة لجلب بيانات التحليلات ---
// [GET] جلب بيانات المبيعات الشهرية للرسوم البيانية
exports.getSalesAnalytics = async (req, res) => {
  const merchantId = req.user.id;
  try {
    const query = `
            SELECT 
                DATE(o.created_at) as date,
                SUM(oi.price * oi.quantity) as dailySales
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE 
                p.merchant_id = ? AND 
                o.status = 'completed' AND
                o.created_at >= NOW() - INTERVAL 30 DAY
            GROUP BY DATE(o.created_at)
            ORDER BY date ASC;
        `;
    const [results] = await pool.query(query, [merchantId]);

    // تنسيق البيانات لتناسب مكتبة الرسوم البيانية Recharts
    const formattedResults = results.map((row) => ({
      name: new Date(row.date).toLocaleDateString("ar-EG", {
        month: "short",
        day: "numeric",
      }),
      المبيعات: row.dailySales,
    }));

    res.status(200).json(formattedResults);
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    res.status(500).json({ message: "خطأ في جلب بيانات التحليلات" });
  }
};

// [GET] جلب إعدادات المتجر
exports.getStoreSettings = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT store_name, store_description, store_banner_url, profile_picture_url, social_links, notifications_prefs, privacy_prefs FROM users WHERE id = ?",
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
    }

    const settings = rows[0];

    // معالجة حقول JSON والتأكد من وجود قيم افتراضية
    settings.social_links = settings.social_links
      ? JSON.parse(settings.social_links)
      : {};
    settings.notifications = settings.notifications_prefs
      ? JSON.parse(settings.notifications_prefs)
      : { email: true, sms: false, push: true };
    settings.privacy = settings.privacy_prefs
      ? JSON.parse(settings.privacy_prefs)
      : { show_email: false, show_phone: false };

    // حذف الحقول القديمة قبل إرسال الاستجابة
    delete settings.notifications_prefs;
    delete settings.privacy_prefs;

    res.status(200).json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    res.status(500).json({ message: "خطأ في جلب الإعدادات." });
  }
};

// [PUT] تحديث إعدادات المتجر
exports.updateStoreSettings = async (req, res) => {
  const {
    store_name,
    store_description,
    store_banner_url,
    profile_picture_url,
    social_links,
    notifications,
    privacy,
  } = req.body;
  try {
    await pool.query(
      "UPDATE users SET store_name = ?, store_description = ?, store_banner_url = ?, profile_picture_url = ?, social_links = ?, notifications_prefs = ?, privacy_prefs = ? WHERE id = ?",
      [
        store_name,
        store_description,
        store_banner_url,
        profile_picture_url,
        JSON.stringify(social_links || {}),
        JSON.stringify(notifications || {}),
        JSON.stringify(privacy || {}),
        req.user.id,
      ]
    );
    res.status(200).json({ message: "تم تحديث الإعدادات بنجاح!" });
  } catch (error) {
    console.error("Error updating store settings:", error);
    res.status(500).json({ message: "خطأ في تحديث الإعدادات." });
  }
};

exports.getSubscriptionDetails = async (req, res) => {
  try {
    const [subscription] = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY start_date DESC LIMIT 1",
      [req.user.id]
    );
    if (subscription.length > 0) {
      res.status(200).json(subscription[0]);
    } else {
      res.status(404).json({ message: "No subscription found" });
    }
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getMerchantShippingCompanies = async (req, res) => {
  try {
    const [companies] = await pool.query(
      "SELECT * FROM shipping_companies WHERE merchant_id = ?",
      [req.user.id]
    );
    res.json(companies);
  } catch (error) {
    res.status(500).json({ message: "فشل في جلب شركات الشحن" });
  }
};

// @desc    إضافة شركة شحن جديدة للتاجر
// @route   POST /api/merchants/shipping
exports.addMerchantShippingCompany = async (req, res) => {
  try {
    const { name, shipping_cost } = req.body;
    const [result] = await pool.query(
      "INSERT INTO shipping_companies (merchant_id, name, shipping_cost) VALUES (?, ?, ?)",
      [req.user.id, name, shipping_cost]
    );
    res.status(201).json({ id: result.insertId, name, shipping_cost });
  } catch (error) {
    res.status(500).json({ message: "فشل في إضافة شركة الشحن" });
  }
};

// @desc    تحديث شركة شحن خاصة بالتاجر
// @route   PUT /api/merchants/shipping/:id
exports.updateMerchantShippingCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, shipping_cost } = req.body;
    // التأكد من أن التاجر يملك هذه الشركة قبل التعديل
    await pool.query(
      "UPDATE shipping_companies SET name = ?, shipping_cost = ? WHERE id = ? AND merchant_id = ?",
      [name, shipping_cost, id, req.user.id]
    );
    res.json({ id, name, shipping_cost });
  } catch (error) {
    res.status(500).json({ message: "فشل في تحديث شركة الشحن" });
  }
};

// @desc    حذف شركة شحن خاصة بالتاجر
// @route   DELETE /api/merchants/shipping/:id
exports.deleteMerchantShippingCompany = async (req, res) => {
  try {
    const { id } = req.params;
    // التأكد من أن التاجر يملك هذه الشركة قبل الحذف
    await pool.query(
      "DELETE FROM shipping_companies WHERE id = ? AND merchant_id = ?",
      [id, req.user.id]
    );
    res.json({ message: "تم حذف شركة الشحن بنجاح" });
  } catch (error) {
    res.status(500).json({ message: "فشل في حذف شركة الشحن" });
  }
};
// --- ✨ ترويج المنتجات (النسخة الموحدة) ✨ ---

// [GET] جلب باقات الترويج المتاحة
exports.getPromotionTiers = asyncHandler(async (req, res) => {
  const [tiers] = await pool.query(
    "SELECT id, name, duration_days, price FROM promotion_tiers WHERE is_active = TRUE ORDER BY price ASC"
  );
  res.json(tiers);
});

/**
 * @desc     Create a promotion request and Stripe checkout session
 * @route    POST /api/merchants/products/:id/promote
 * @access   Private/Merchant
 */
exports.promoteProduct = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id: productId } = req.params;
  const { tierId } = req.body;
  const merchantId = req.user.id;

  const [[tier]] = await pool.query(
    "SELECT * FROM promotion_tiers WHERE id = ? AND is_active = TRUE",
    [tierId]
  );
  if (!tier) {
    return res.status(404).json({ message: "Baqah not found" });
  }

  const [[product]] = await pool.query(
    "SELECT * FROM products WHERE id = ? AND merchant_id = ?",
    [productId, merchantId]
  );
  if (!product) {
    return res
      .status(404)
      .json({ message: "Product not found or does not belong to you" });
  }

  // ✨ التعديل: لم نعد ننشئ سجل ترويج هنا

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "sar",
          product_data: {
            name: `ترويج للمنتج: ${product.name}`,
            description: `باقة ${tier.name} (${tier.duration_days} يوم)`,
          },
          unit_amount: tier.price * 100,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `${process.env.FRONTEND_URL}/dashboard/products?promotion_success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard/products?promotion_canceled=true`,
    metadata: {
      // ✨ التعديل: نرسل كل البيانات التي نحتاجها للـ webhook
      sessionType: "product_promotion",
      productId: productId,
      tierId: tierId,
      merchantId: merchantId,
    },
  });

  res.json({ checkoutUrl: session.url });
});

/**
 * @desc    حذف منتج خاص بالتاجر (بما في ذلك منتجات الدروبشيبينغ)
 * @route   DELETE /api/merchants/products/:id
 * @access  Private (Merchant)
 */
exports.deleteProduct = asyncHandler(async (req, res) => {
  const { id: productId } = req.params;
  const merchantId = req.user.id;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. التحقق من أن المنتج ينتمي للتاجر
    const [[product]] = await connection.query(
      "SELECT id FROM products WHERE id = ? AND merchant_id = ?",
      [productId, merchantId]
    );

    if (!product) {
      await connection.rollback();
      connection.release();
      return res
        .status(404)
        .json({ message: "المنتج غير موجود أو لا تملك صلاحية حذفه." });
    }

    // --- حذف السجلات المرتبطة بالترتيب الصحيح ---

    // 2. جلب معرفات متغيرات هذا المنتج
    const [variants] = await connection.query(
      "SELECT id FROM product_variants WHERE product_id = ?",
      [productId]
    );
    const variantIds = variants.map((v) => v.id);

    // 3. حذف الروابط من dropship_links (إذا وجدت)
    if (variantIds.length > 0) {
      await connection.query(
        "DELETE FROM dropship_links WHERE merchant_variant_id IN (?)",
        [variantIds]
      );
    }

    // 4. حذف سجلات الترويج المرتبطة بالمنتج (إذا وجدت)
    await connection.query(
      "DELETE FROM product_promotions WHERE product_id = ?",
      [productId]
    );

    // 5. حذف سجلات الاتفاقيات المرتبطة بالمنتج (إذا وجدت)
    await connection.query("DELETE FROM agreements WHERE product_id = ?", [
      productId,
    ]);

    // 6. حذف تقييمات المنتج (إذا وجدت)
    await connection.query("DELETE FROM product_reviews WHERE product_id = ?", [
      productId,
    ]);

    // 7. حذف المنتج من قوائم الرغبات (إذا وجد)
    await connection.query("DELETE FROM wishlist WHERE product_id = ?", [
      productId,
    ]);

    // 8. حذف متغيرات المنتج (إذا كانت مرتبطة بـ ON DELETE CASCADE، سيتم حذفها تلقائيًا عند حذف المنتج)
    // ✅ [FIX] تم إزالة السطر الذي يشير إلى الجدول غير الموجود `product_variant_images`
    if (variantIds.length > 0) {
      // فقط نحذف المتغيرات نفسها، إذا لم تكن ON DELETE CASCADE
      // إذا كانت ON DELETE CASCADE، يمكن إزالة هذا السطر أيضًا.
      await connection.query(
        "DELETE FROM product_variants WHERE product_id = ?",
        [productId]
      );
    }

    // 9. الآن يمكننا حذف المنتج الرئيسي بأمان
    await connection.query("DELETE FROM products WHERE id = ?", [productId]);

    // 10. إكمال المعاملة
    await connection.commit();
    res
      .status(200)
      .json({ message: "تم حذف المنتج وجميع بياناته المرتبطة بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error deleting product:", error);
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      res
        .status(400)
        .json({
          message: "لا يمكن حذف المنتج لوجود بيانات مرتبطة به لم يتم حذفها.",
          details: error.sqlMessage,
        });
    } else if (error.code === "ER_NO_SUCH_TABLE") {
      res
        .status(500)
        .json({
          message: "خطأ في الخادم: محاولة الوصول إلى جدول غير موجود.",
          details: error.sqlMessage,
        });
    } else {
      res.status(500).json({ message: "حدث خطأ غير متوقع أثناء حذف المنتج." });
    }
  } finally {
    connection.release();
  }
});

// @desc    Get merchant public profile by ID
// @route   GET /api/merchants/public-profile/:id
// @access  Public
exports.getMerchantPublicProfile = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // [1] جلب بيانات التاجر
  const [users] = await pool.query(
    "SELECT id, name, store_name, profile_picture_url, bio FROM users WHERE id = ? AND role_id = 2 AND is_email_verified = 1",
    [id]
  );

  if (users.length === 0) {
    res.status(404);
    throw new Error("Merchant not found");
  }

  const merchant = users[0];

  // [2] جلب المنتجات (نفس الاستعلام الذي جلب البيانات الخام بنجاح)
  const [rawProducts] = await pool.query(
    `SELECT 
        p.id, p.name, p.status,
        u.store_name as merchantName,
        (SELECT AVG(rating) FROM product_reviews WHERE product_id = p.id) as rating,
        (SELECT COUNT(*) FROM product_reviews WHERE product_id = p.id) as reviewCount,
        (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) as price,
        (SELECT pv.images FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1) as variant_images_json
     FROM products p
     JOIN users u ON p.merchant_id = u.id
     WHERE p.merchant_id = ? AND p.status = "active" 
     ORDER BY p.created_at DESC`,
    [id]
  );

  // --- ✨ [3] تنسيق البيانات لتطابق ProductCard.tsx ---
  const products = rawProducts.map((product) => {
    let variantImages = [];
    try {
      // الـ log أثبت أن هذا السطر يرجع ["https://..."]
      variantImages = JSON.parse(product.variant_images_json || "[]");
    } catch (e) {
      console.error("Failed to parse images:", product.variant_images_json);
    }

    // [الحل] نقوم بإنشاء "خيار" (variant) واحد فقط
    // ونضع فيه البيانات التي يتوقعها ProductCard
    const simulatedVariant = {
      price: product.price || 0,
      compare_at_price: product.compare_at_price || null, // (لم نجلب هذا، لكن null آمن)
      images: variantImages, // <-- مصفوفة الصور التي يبحث عنها ProductCard
    };

    return {
      // البيانات الأساسية للمنتج
      id: product.id,
      name: product.name,
      status: product.status,
      rating: product.rating,
      reviewCount: product.reviewCount,
      merchantName: product.merchantName, // <-- اسم التاجر الذي يبحث عنه ProductCard

      // ✨ الأهم: نضع الخيار المزيف داخل مصفوفة variants
      variants: [simulatedVariant],
    };
  });
  // ----------------------------------------

  res.json({
    ...merchant,
    products: products || [], // <-- إرسال المنتجات بالتنسيق الصحيح
  });
});
