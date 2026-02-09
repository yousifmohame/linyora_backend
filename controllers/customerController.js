// backend/controllers/customerController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const asyncHandler = require('express-async-handler');

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
        [userId, userId, userId]
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
        [userId]
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
      [customerId]
    );
    res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching customer orders:", error);
    res.status(500).json({ message: "خطأ في جلب الطلبات." });
  }
};

// [GET] جلب تفاصيل طلب واحد خاص بالعميل
exports.getCustomerOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const customerId = req.user.id;

    // This first query for order details is correct and remains unchanged.
    const [orderDetails] = await pool.query(
      `SELECT 
                o.id, o.created_at, o.status, o.total_amount as totalAmount,
                o.tracking_number as trackingNumber,
                o.payment_status as paymentStatus,
                o.payment_method as paymentMethod,
                o.shipping_cost,
                o.tax_amount,
                sc.name as shippingCompanyName,
                addr.full_name as shippingFullName,
                addr.address_line_1 as shippingAddress1,
                addr.address_line_2 as shippingAddress2,
                addr.city as shippingCity,
                addr.state_province_region as shippingState,
                addr.postal_code as shippingPostalCode,
                addr.country as shippingCountry,
                addr.phone_number as shippingPhone
             FROM orders o
             LEFT JOIN shipping_companies sc ON o.shipping_company_id = sc.id
             LEFT JOIN addresses addr ON o.shipping_address_id = addr.id
             WHERE o.id = ? AND o.customer_id = ?`,
      [orderId, customerId]
    );

    if (orderDetails.length === 0) {
      return res
        .status(404)
        .json({
          message: "Order not found or you do not have permission to view it.",
        });
    }

    // ✅ --- START: CORRECTED SQL QUERY FOR ORDER ITEMS ---
    // This query now correctly selects `images` from the `product_variants` table (aliased as `pv`).
    const [orderItems] = await pool.query(
      `SELECT 
                oi.product_id,
                oi.quantity, 
                oi.price,
                p.name as productName,
                pv.color,
                pv.images
             FROM order_items oi
             JOIN products p ON oi.product_id = p.id
             LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
             WHERE oi.order_id = ?`,
      [orderId]
    );
    // ✅ --- END: CORRECTED SQL QUERY FOR ORDER ITEMS ---

    const order = {
      details: {
        ...orderDetails[0],
        shippingAddress: {
          fullName: orderDetails[0].shippingFullName,
          address1: orderDetails[0].shippingAddress1,
          address2: orderDetails[0].shippingAddress2,
          city: orderDetails[0].shippingCity,
          state: orderDetails[0].shippingState,
          postalCode: orderDetails[0].shippingPostalCode,
          country: orderDetails[0].shippingCountry,
          phone: orderDetails[0].shippingPhone,
        },
      },
      // ✅ This now correctly parses the JSON string from the `images` column.
      items: orderItems.map((item) => ({
        ...item,
        images: item.images ? JSON.parse(item.images) : [],
      })),
    };

    res.json(order);
  } catch (error) {
    console.error("Error fetching order details:", error);
    res.status(500).json({ message: "Failed to fetch order details." });
  }
};

// [POST] إضافة تقييم لمنتج
exports.addProductReview = async (req, res) => {
  const { productId, rating, comment } = req.body;
  const userId = req.user.id;

  if (!productId || !rating) {
    return res.status(400).json({ message: "المنتج والتقييم مطلوبان." });
  }

  try {
    // 1. ✅ التحقق: هل قام المستخدم بتقييم هذا المنتج مسبقاً؟
    const [existingReview] = await pool.query(
      "SELECT id FROM product_reviews WHERE product_id = ? AND user_id = ?",
      [productId, userId]
    );

    if (existingReview.length > 0) {
      // 409 Conflict: يعني أن الطلب يتعارض مع الحالة الحالية للموارد (موجود مسبقاً)
      return res.status(409).json({ 
        message: "لقد قمت بتقييم هذا المنتج مسبقاً.",
        code: "ALREADY_REVIEWED" // كود نستخدمه في الفرونت إند
      });
    }

    // 2. (اختياري احترافي) التحقق من أن العميل اشترى المنتج بالفعل
    /*
    const [purchase] = await pool.query(
       `SELECT id FROM order_items oi 
        JOIN orders o ON oi.order_id = o.id 
        WHERE oi.product_id = ? AND o.user_id = ? AND o.status = 'delivered'`,
       [productId, userId]
    );
    if (purchase.length === 0) {
       return res.status(403).json({ message: "يجب شراء المنتج واستلامه قبل التقييم." });
    }
    */

    // 3. إضافة التقييم
    await pool.query(
      "INSERT INTO product_reviews (product_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())",
      [productId, userId, rating, comment]
    );

    res.status(201).json({ message: "تمت إضافة تقييمك بنجاح!" });

  } catch (error) {
    console.error("Error adding product review:", error);
    res.status(500).json({ message: "فشل إضافة التقييم." });
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
      [req.user.id]
    );

    if (products.length === 0) {
      return res.status(200).json([]);
    }

    const productIds = products.map((p) => p.id);

    // الخطوة 2: جلب جميع متغيرات هذه المنتجات
    const [variants] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id IN (?)",
      [productIds]
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
      [req.user.id, productId]
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
      return res.status(401).json({ message: "غير مصرح، يرجى تسجيل الدخول للوصول إلى المفضلة." });
  }

  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    return res.status(200).json({});
  }

  try {
    const [results] = await pool.query(
      "SELECT product_id FROM wishlist WHERE user_id = ? AND product_id IN (?)",
      [req.user.id, productIds]
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
      [req.user.id, productId]
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
    const [addresses] = await pool.query("SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC", [req.user.id]);
    res.status(200).json(addresses);
});

// @desc    Add a new address
// @route   POST /api/customer/addresses
// @access  Private (Customer)
exports.addAddress = asyncHandler(async (req, res) => {
    const { address_line1, address_line2, city, state, postal_code, country, is_default } = req.body;
    const userId = req.user.id;

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        if (is_default) {
            await connection.query("UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?", [userId]);
        }
        const [result] = await connection.query(
            "INSERT INTO customer_addresses (user_id, address_line1, address_line2, city, state, postal_code, country, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [userId, address_line1, address_line2 || null, city, state, postal_code, country, is_default]
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
    const { address_line1, address_line2, city, state, postal_code, country, is_default } = req.body;
    const userId = req.user.id;
    
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
        if (is_default) {
            await connection.query("UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?", [userId]);
        }
        const [result] = await connection.query(
            "UPDATE customer_addresses SET address_line1 = ?, address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, is_default = ? WHERE id = ? AND user_id = ?",
            [address_line1, address_line2 || null, city, state, postal_code, country, is_default, id, userId]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Address not found or user not authorized' });
        }
        
        await connection.commit();
        res.status(200).json({ message: 'Address updated successfully' });
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
    const [result] = await pool.query("DELETE FROM customer_addresses WHERE id = ? AND user_id = ?", [id, req.user.id]);

    if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Address not found or user not authorized' });
    }
    res.status(200).json({ message: 'Address deleted successfully' });
});
