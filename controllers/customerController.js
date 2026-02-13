// backend/controllers/customerController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const asyncHandler = require("express-async-handler");

exports.getDashboardStats = async (req, res) => {
  const userId = req.user.id;
  try {
    const [stats] = await Promise.all([
      // جلب الإحصائيات الرئيسية في استعلام واحد
      pool.query(
        `SELECT 
                    (SELECT COUNT(*) FROM orders WHERE customer_id = ?) as totalOrders,
                    (SELECT COUNT(DISTINCT product_id) FROM product_reviews WHERE user_id = ?) as reviewedProducts,
                    (SELECT COUNT(*) FROM wishlist WHERE user_id = ?) as wishlistItems`,
        [userId, userId, userId],
      ),
      // جلب آخر طلب
      pool.query(
        `SELECT o.id, o.status, SUM(oi.price * oi.quantity) as totalAmount, o.created_at 
                 FROM orders o 
                 JOIN order_items oi ON o.id = oi.order_id 
                 WHERE o.customer_id = ? 
                 GROUP BY o.id 
                 ORDER BY o.created_at DESC 
                 LIMIT 1`,
        [userId],
      ),
    ]);

    const [mainStats] = stats[0];
    const [latestOrder] = stats[1];

    res.status(200).json({
      totalOrders: mainStats.totalOrders || 0,
      reviewedProducts: mainStats.reviewedProducts || 0,
      wishlistItems: mainStats.wishlistItems || 0,
      latestOrder: latestOrder.length > 0 ? latestOrder[0] : null,
    });
  } catch (error) {
    console.error("Error fetching customer dashboard stats:", error);
    res.status(500).json({ message: "Server error." });
  }
};

// [GET] جلب جميع طلبات العميل الحالي
exports.getCustomerOrders = async (req, res) => {
  try {
    const customerId = req.user.id;
    const [orders] = await pool.query(
      `SELECT 
                o.id, 
                o.created_at as orderDate, 
                o.status, 
                o.total_amount as totalAmount,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as itemsCount
             FROM orders o
             WHERE o.customer_id = ?
             ORDER BY o.created_at DESC`,
      [customerId],
    );
    res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    res.status(500).json({ message: "خطأ في جلب الطلبات." });
  }
};

// [GET] جلب تفاصيل طلب واحد خاص بالعميل
// [GET] جلب تفاصيل طلب واحد خاص بالعميل
exports.getCustomerOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const customerId = req.user.id;

    // 1. جلب تفاصيل الطلب الرئيسية (كما هي)
    const [orderDetails] = await pool.query(
      `SELECT 
                o.id, o.created_at, o.status, o.total_amount as totalAmount,
                o.tracking_number as trackingNumber,
                o.payment_status as paymentStatus,
                o.payment_method as paymentMethod,
                o.shipping_cost,
                sc.name as shippingCompanyName,
                addr.full_name as shippingFullName,
                addr.address_line_1 as shippingAddress1,
                addr.address_line_2 as shippingAddress2,
                addr.city as shippingCity,
                addr.phone_number as shippingPhone
             FROM orders o
             LEFT JOIN shipping_companies sc ON o.shipping_company_id = sc.id
             LEFT JOIN addresses addr ON o.shipping_address_id = addr.id
             WHERE o.id = ? AND o.customer_id = ?`,
      [orderId, customerId],
    );

    if (orderDetails.length === 0) {
      return res.status(404).json({ message: "الطلب غير موجود." });
    }

    // 2. ✅✅ التعديل هنا: جلب العناصر مع حالة التقييم
    const [orderItems] = await pool.query(
      `SELECT 
            oi.product_id,
            oi.quantity, 
            oi.price,
            p.name as productName,
            pv.color,
            pv.images,
            
            -- 🔥 أعمدة جديدة لجلب بيانات التقييم
            pr.rating as myRating,
            pr.comment as myComment,
            CASE WHEN pr.id IS NOT NULL THEN 1 ELSE 0 END as isReviewed

         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
         
         -- 🔥 ربط جدول التقييمات للتحقق مما إذا كان المستخدم الحالي قد قيم المنتج
         LEFT JOIN product_reviews pr ON (oi.product_id = pr.product_id AND pr.user_id = ?)
         
         WHERE oi.order_id = ?`,
      [customerId, orderId], // ⚠️ الترتيب مهم: customerId أولاً للـ JOIN، ثم orderId للـ WHERE
    );

    const order = {
      details: {
        ...orderDetails[0],
        shippingAddress: {
          fullName: orderDetails[0].shippingFullName,
          address1: orderDetails[0].shippingAddress1,
          city: orderDetails[0].shippingCity,
          phone: orderDetails[0].shippingPhone,
        },
      },
      items: orderItems.map((item) => ({
        ...item,
        images: (() => {
          try {
            return typeof item.images === "string"
              ? JSON.parse(item.images)
              : item.images || [];
          } catch {
            return [];
          }
        })(),
        // تحويل القيم للتنسيق المناسب للفرونت إند
        isReviewed: Boolean(item.isReviewed), // يحول 1/0 إلى true/false
        myRating: item.myRating || 0,
        myComment: item.myComment || "",
      })),
    };

    res.json(order);
  } catch (error) {
    console.error("Error fetching order details:", error);
    res.status(500).json({ message: "فشل جلب تفاصيل الطلب." });
  }
};

// [POST] إضافة تقييم لمنتج
exports.addProductReview = async (req, res) => {
  const { productId, rating, comment } = req.body;
  const userId = req.user.id;

  try {
    const [existingReview] = await pool.query(
      "SELECT id FROM product_reviews WHERE product_id = ? AND user_id = ?",
      [productId, userId],
    );

    if (existingReview.length > 0) {
      // ✅ تحديث التقييم الموجود بدلاً من إرجاع خطأ 409
      await pool.query(
        "UPDATE product_reviews SET rating = ?, comment = ?, created_at = NOW() WHERE id = ?",
        [rating, comment, existingReview[0].id],
      );
      return res.status(200).json({ message: "تم تحديث تقييمك بنجاح!" });
    }

    // إضافة تقييم جديد إذا لم يوجد
    await pool.query(
      "INSERT INTO product_reviews (product_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())",
      [productId, userId, rating, comment],
    );
    res.status(201).json({ message: "تمت إضافة التقييم بنجاح!" });
  } catch (error) {
    res.status(500).json({ message: "فشل في معالجة التقييم." });
  }
};

// [PUT] تحديث الملف الشخصي للعميل
exports.updateProfile = async (req, res) => {
  const { name, email, password } = req.body;
  const userId = req.user.id;

  try {
    let query = "UPDATE users SET name = ?, email = ?";
    const params = [name, email];

    if (password) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      query += ", password = ?";
      params.push(hashedPassword);
    }

    query += " WHERE id = ?";
    params.push(userId);

    await pool.query(query, params);

    res.status(200).json({ message: "تم تحديث ملفك الشخصي بنجاح!" });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "فشل تحديث الملف الشخصي." });
  }
};

exports.getWishlist = async (req, res) => {
  try {
    // الخطوة 1: جلب المنتجات الموجودة في قائمة أمنيات المستخدم مع إحصائيات التقييم
    const [products] = await pool.query(
      `SELECT 
                p.id, p.name, p.description, p.brand, p.status,
                u.name as merchantName,
                (SELECT AVG(rating) FROM product_reviews WHERE product_id = p.id) as rating,
                (SELECT COUNT(*) FROM product_reviews WHERE product_id = p.id) as reviewCount
             FROM wishlist w
             JOIN products p ON w.product_id = p.id
             JOIN users u ON p.merchant_id = u.id
             WHERE w.user_id = ?`,
      [req.user.id],
    );

    if (products.length === 0) {
      return res.status(200).json([]);
    }

    const productIds = products.map((p) => p.id);

    // الخطوة 2: جلب جميع متغيرات هذه المنتجات
    const [variants] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id IN (?)",
      [productIds],
    );

    // تجميع المتغيرات لكل منتج
    const variantsMap = new Map();
    variants.forEach((variant) => {
      try {
        variant.images = JSON.parse(variant.images);
      } catch (e) {
        variant.images = [];
      }
      const items = variantsMap.get(variant.product_id) || [];
      items.push(variant);
      variantsMap.set(variant.product_id, items);
    });

    // الخطوة 3: دمج البيانات وإرسالها
    const fullProducts = products.map((product) => ({
      ...product,
      variants: variantsMap.get(product.id) || [],
      rating: parseFloat(product.rating) || 0,
      reviewCount: parseInt(product.reviewCount, 10) || 0,
    }));

    res.status(200).json(fullProducts);
  } catch (error) {
    console.error("Error fetching wishlist:", error);
    res.status(500).json({ message: "Server error while fetching wishlist." });
  }
};

// [POST] إضافة منتج إلى قائمة الأمنيات
exports.addToWishlist = async (req, res) => {
  const { productId } = req.body;
  if (!productId) {
    return res.status(400).json({ message: "معرف المنتج مطلوب." });
  }
  try {
    await pool.query(
      "INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)",
      [req.user.id, productId],
    );
    res.status(201).json({ message: "تمت إضافة المنتج إلى قائمة الأمنيات!" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "المنتج موجود بالفعل في قائمة أمنياتك." });
    }
    console.error("Error adding to wishlist:", error);
    res.status(500).json({ message: "Server error." });
  }
};

exports.checkWishlistStatus = async (req, res) => {
  const { productIds } = req.body;

  // ✅ إصلاح: التحقق من وجود المستخدم قبل الوصول إلى الـ ID
  // هذا يمنع تعطل السيرفر إذا تم استدعاء الرابط بدون تسجيل دخول
  if (!req.user || !req.user.id) {
    return res
      .status(401)
      .json({ message: "غير مصرح، يرجى تسجيل الدخول للوصول إلى المفضلة." });
  }

  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    return res.status(200).json({});
  }

  try {
    const [results] = await pool.query(
      "SELECT product_id FROM wishlist WHERE user_id = ? AND product_id IN (?)",
      [req.user.id, productIds],
    );

    // إنشاء كائن (object) لسهولة البحث في الواجهة الأمامية
    const statusMap = {};
    results.forEach((item) => {
      statusMap[item.product_id] = true;
    });

    res.status(200).json(statusMap);
  } catch (error) {
    console.error("Error checking wishlist status:", error);
    res.status(500).json({ message: "Server error." });
  }
};

// [DELETE] إزالة منتج من قائمة الأمنيات
exports.removeFromWishlist = async (req, res) => {
  const { productId } = req.params;
  try {
    const [result] = await pool.query(
      "DELETE FROM wishlist WHERE user_id = ? AND product_id = ?",
      [req.user.id, productId],
    );
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "المنتج غير موجود في قائمة الأمنيات." });
    }
    res.status(200).json({ message: "تمت إزالة المنتج من قائمة الأمنيات." });
  } catch (error) {
    console.error("Error removing from wishlist:", error);
    res.status(500).json({ message: "Server error." });
  }
};

// @desc    Get all addresses for the logged-in customer
// @route   GET /api/customer/addresses
// @access  Private (Customer)
exports.getAddresses = asyncHandler(async (req, res) => {
  const [addresses] = await pool.query(
    "SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC",
    [req.user.id],
  );
  res.status(200).json(addresses);
});

// @desc    Add a new address
// @route   POST /api/customer/addresses
// @access  Private (Customer)
exports.addAddress = asyncHandler(async (req, res) => {
  const {
    address_line1,
    address_line2,
    city,
    state,
    postal_code,
    country,
    is_default,
  } = req.body;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    if (is_default) {
      await connection.query(
        "UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?",
        [userId],
      );
    }
    const [result] = await connection.query(
      "INSERT INTO customer_addresses (user_id, address_line1, address_line2, city, state, postal_code, country, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        address_line1,
        address_line2 || null,
        city,
        state,
        postal_code,
        country,
        is_default,
      ],
    );
    await connection.commit();
    res.status(201).json({ id: result.insertId, ...req.body });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

// @desc    Update an address
// @route   PUT /api/customer/addresses/:id
// @access  Private (Customer)
exports.updateAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    address_line1,
    address_line2,
    city,
    state,
    postal_code,
    country,
    is_default,
  } = req.body;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    if (is_default) {
      await connection.query(
        "UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?",
        [userId],
      );
    }
    const [result] = await connection.query(
      "UPDATE customer_addresses SET address_line1 = ?, address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, is_default = ? WHERE id = ? AND user_id = ?",
      [
        address_line1,
        address_line2 || null,
        city,
        state,
        postal_code,
        country,
        is_default,
        id,
        userId,
      ],
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "Address not found or user not authorized" });
    }

    await connection.commit();
    res.status(200).json({ message: "Address updated successfully" });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

// @desc    Delete an address
// @route   DELETE /api/customer/addresses/:id
// @access  Private (Customer)
exports.deleteAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query(
    "DELETE FROM customer_addresses WHERE id = ? AND user_id = ?",
    [id, req.user.id],
  );

  if (result.affectedRows === 0) {
    return res
      .status(404)
      .json({ message: "Address not found or user not authorized" });
  }
  res.status(200).json({ message: "Address deleted successfully" });
});
