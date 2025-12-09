// linora-platform/backend/controllers/browseController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

const fetchFullProductData = async (productRows) => {
  if (!productRows || productRows.length === 0) {
    return [];
  }

  const productIds = productRows.map((p) => p.id);

  // 1. جلب بيانات المنتج الأساسية + التاجر + التقييمات + بيانات المورد (الجديد)
  const [products] = await pool.query(
    `
    SELECT 
      p.id, 
      p.name, 
      p.description, 
      p.brand,
      p.merchant_id,
      p.created_at,
      u.store_name as merchantName,
      COALESCE(AVG(pr.rating), 0) as rating,
      COUNT(DISTINCT pr.id) as reviewCount,
      
      -- ✨ بيانات الدروبشيبينغ (الجديد)
      MAX(sp.supplier_id) as supplier_id,
      MAX(sup_u.name) as supplier_name,
      (MAX(sp.supplier_id) IS NOT NULL) as is_dropshipping

    FROM products p
    JOIN users u ON p.merchant_id = u.id
    LEFT JOIN product_reviews pr ON p.id = pr.product_id
    
    -- ✨ الربط مع جداول الدروبشيبينغ
    LEFT JOIN product_variants pv ON p.id = pv.product_id
    LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
    LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
    LEFT JOIN supplier_products sp ON spv.product_id = sp.id
    LEFT JOIN users sup_u ON sp.supplier_id = sup_u.id

    WHERE p.id IN (?)
    GROUP BY p.id
  `,
    [productIds]
  );

  // 2. جلب كل الخيارات (variants) لهذه المنتجات
  const [variants] = await pool.query(
    "SELECT * FROM product_variants WHERE product_id IN (?)",
    [productIds]
  );

  // 3. تجميع الخيارات في Map لسهولة الوصول
  const variantsMap = new Map();
  variants.forEach((variant) => {
    try {
      variant.images = JSON.parse(variant.images || "[]");
    } catch (e) {
      variant.images = [];
    }
    const items = variantsMap.get(variant.product_id) || [];
    items.push(variant);
    variantsMap.set(variant.product_id, items);
  });

  // 4. دمج المنتجات مع الخيارات الخاصة بها
  const fullProducts = products.map((product) => ({
    ...product,
    rating: parseFloat(product.rating),
    // تحويل القيمة المنطقية
    is_dropshipping: !!product.is_dropshipping,
    variants: variantsMap.get(product.id) || [],
  }));

  // 5. إعادة ترتيب المنتجات بنفس الترتيب الأصلي
  return productIds
    .map((id) => fullProducts.find((p) => p.id === id))
    .filter(Boolean);
};

// [GET] جلب قائمة بكل العارضات والمؤثرات مع بياناتهن الأساسية
exports.getAllModels = async (req, res) => {
  try {
    const [models] = await pool.query(
      `SELECT id, name, store_name, role_id, profile_picture_url, bio, stats 
       FROM users 
       WHERE role_id IN (3, 4)`
    );
    res.status(200).json(models);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب قائمة العارضات" });
  }
};

/**
 * @desc    Get public profile for a single model/influencer, including their service packages
 * @route   GET /api/browse/models/:id
 * @access  Public
 */
exports.getPublicModelProfile = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [userResult] = await pool.query(
    `SELECT 
        u.id, u.name, u.role_id, u.profile_picture_url, u.bio, u.portfolio, u.social_links, 
        u.stats, u.address, u.categories, u.experience_years, u.languages, u.is_verified, u.is_featured,
        COALESCE(AVG(ar.rating), 0) as rating,
        (SELECT COUNT(*) FROM agreements WHERE model_id = u.id AND status = 'completed') as completed_campaigns
     FROM users u
     LEFT JOIN agreement_reviews ar ON u.id = ar.reviewee_id
     WHERE u.id = ? AND u.role_id IN (3, 4)
     GROUP BY u.id`,
    [id]
  );

  if (userResult.length === 0) {
    return res.status(404).json({ message: "المستخدم غير موجود." });
  }

  const profile = userResult[0];

  // Safely parse all JSON fields
  ["portfolio", "social_links", "stats", "categories", "languages"].forEach(
    (field) => {
      try {
        const isArrayField = ["portfolio", "categories", "languages"].includes(
          field
        );
        profile[field] = profile[field]
          ? JSON.parse(profile[field])
          : isArrayField
          ? []
          : {};
      } catch (e) {
        const isArrayField = ["portfolio", "categories", "languages"].includes(
          field
        );
        profile[field] = isArrayField ? [] : {};
      }
    }
  );

  const [packages] = await pool.query(
    "SELECT * FROM service_packages WHERE user_id = ? AND status = 'active'",
    [id]
  );

  if (packages.length === 0) {
    return res.status(200).json({ profile, packages: [] });
  }

  const packageIds = packages.map((p) => p.id);
  const [tiers] = await pool.query(
    "SELECT * FROM package_tiers WHERE package_id IN (?) ORDER BY price ASC",
    [packageIds]
  );

  const packagesWithTiers = packages.map((pkg) => ({
    ...pkg,
    tiers: tiers
      .filter((tier) => tier.package_id === pkg.id)
      .map((t) => ({
        ...t,
        features: t.features ? JSON.parse(t.features) : [],
      })),
  }));

  res.status(200).json({
    profile,
    packages: packagesWithTiers,
  });
});

/**
 * @desc    Get all active promoted products for the trends page
 * @route   GET /api/browse/trends
 * @access  Public
 */
exports.getPromotedProducts = asyncHandler(async (req, res) => {
  const query = `
        SELECT
            p.id,
            p.name,
            p.brand,
            v.price,
            v.compare_at_price, -- Now correctly selected
            v.images,
            pt.name as promotion_tier_name,
            pt.badge_color
        FROM products p
        JOIN product_promotions pp ON p.id = pp.product_id
        JOIN promotion_tiers pt ON pp.promotion_tier_id = pt.id
        -- This subquery now joins the full data of the cheapest variant for each product
        JOIN (
            SELECT 
                pv.product_id,
                pv.price,
                pv.compare_at_price,
                pv.images
            FROM product_variants pv
            INNER JOIN (
                SELECT
                    product_id,
                    MIN(price) AS min_price
                FROM product_variants
                GROUP BY product_id
            ) pmin ON pv.product_id = pmin.product_id AND pv.price = pmin.min_price
            GROUP BY pv.product_id
        ) v ON p.id = v.product_id
        WHERE 
            p.status = 'active'
            AND pp.status = 'active'
            AND pp.end_date > NOW()
        ORDER BY
            pt.priority DESC,
            pp.created_at DESC;
    `;

  const [products] = await pool.query(query);

  const processedProducts = products.map((product) => {
    let imageArray = [];
    try {
      if (product.images && typeof product.images === "string") {
        imageArray = JSON.parse(product.images);
      }
    } catch (e) {
      /* ignore parse error */
    }

    return {
      ...product,
      image: imageArray.length > 0 ? imageArray[0] : null,
      images: undefined,
    };
  });

  res.status(200).json(processedProducts);
});

/**
 * @desc    Get category details and products by category slug
 * @route   GET /api/browse/categories/:slug
 * @access  Public
 */
exports.getProductsByCategorySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;

  // 1. العثور على التصنيف
  const [[category]] = await pool.query(
    "SELECT id, name, description FROM categories WHERE slug = ?",
    [slug]
  );

  if (!category) {
    return res.status(404).json({ message: "Category not found" });
  }

  // 2. جلب المنتجات المرتبطة بهذا التصنيف
  const [products] = await pool.query(
    `
        SELECT
            p.id,
            p.name,
            p.brand,
            u.name AS merchantName,
            (SELECT MIN(v.price) FROM product_variants v WHERE v.product_id = p.id) as price,
            (SELECT v.compare_at_price FROM product_variants v WHERE v.product_id = p.id ORDER BY v.price ASC LIMIT 1) as compare_at_price,
            (SELECT v.images FROM product_variants v WHERE v.product_id = p.id ORDER BY v.id ASC LIMIT 1) as images,
            AVG(r.rating) as rating,
            COUNT(DISTINCT r.id) as reviewCount
        FROM products p
        JOIN product_categories pc ON p.id = pc.product_id
        JOIN users u ON p.merchant_id = u.id
        LEFT JOIN product_reviews r ON p.id = r.product_id
        WHERE pc.category_id = ? AND p.status = 'active'
        GROUP BY p.id
        ORDER BY p.created_at DESC
    `,
    [category.id]
  );

  // معالجة الصور لضمان إرسال صورة واحدة فقط
  const processedProducts = products.map((p) => {
    let firstImage = null;
    if (p.images) {
      try {
        const parsedImages = JSON.parse(p.images);
        if (Array.isArray(parsedImages) && parsedImages.length > 0) {
          firstImage = parsedImages[0];
        }
      } catch (e) {
        // تجاهل الخطأ إذا لم تكن البيانات JSON
      }
    }
    return { ...p, image: firstImage, images: undefined };
  });

  res.status(200).json({ category, products: processedProducts });
});

exports.getTrendingProducts = async (req, res) => {
  try {
    // سنعتبر الترند هو المنتجات الأكثر مبيعاً في آخر 30 يوماً
    const query = `
            SELECT
                p.id,
                p.name,
                p.description,
                MIN(pv.price) as price, -- نعرض أقل سعر للخيار المتاح
                MIN(pv.compare_at_price) as compare_at_price,
                (SELECT image_url FROM supplier_variant_images svi JOIN supplier_product_variants spv ON svi.variant_id = spv.id JOIN dropship_links dl ON spv.id = dl.supplier_variant_id WHERE dl.merchant_variant_id = MIN(pv.id) ORDER BY svi.sort_order LIMIT 1) as image_url, -- صورة أول خيار متاح مرتبط بالمورد
                SUM(oi.quantity) as total_sold
            FROM order_items oi
            JOIN product_variants pv ON oi.product_variant_id = pv.id
            JOIN products p ON pv.product_id = p.id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
              AND o.payment_status = 'paid' -- فقط الطلبات المدفوعة
              AND p.status = 'active'
            GROUP BY p.id, p.name, p.description
            ORDER BY total_sold DESC
            LIMIT 5; -- نأخذ أعلى 5 منتجات
        `;

    const [results] = await pool.query(query);

    // تنسيق البيانات لتناسب واجهة ProductCard/TrendCard
    const trendingProducts = results.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      // نفترض أن ProductCard/TrendCard يحتاج structure مشابه
      variants: [
        {
          id: 0, // معرف وهمي للخيار
          price: row.price,
          compare_at_price: row.compare_at_price,
          images: row.image_url ? [row.image_url] : [], // يجب أن يكون مصفوفة
        },
      ],
    }));

    res.status(200).json(trendingProducts);
  } catch (error) {
    console.error("Error fetching trending products:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching trending products" });
  }
};

// === دالة جديدة لجلب كل المنتجات لغرض الربط (Tagging) ===
exports.getAllProductsForTagging = async (req, res) => {
  try {
    // جلب المنتجات النشطة فقط (الاسم، المعرف، وصورة)
    const query = `
            SELECT 
                p.id, 
                p.name, 
                (SELECT svi.image_url 
                 FROM supplier_variant_images svi
                 JOIN supplier_product_variants spv ON svi.variant_id = spv.id
                 JOIN dropship_links dl ON spv.id = dl.supplier_variant_id
                 JOIN product_variants pv ON dl.merchant_variant_id = pv.id
                 WHERE pv.product_id = p.id
                 ORDER BY svi.sort_order LIMIT 1
                ) as image_url
            FROM products p
            WHERE p.status = 'active';
        `;

    const [products] = await pool.query(query);

    // إضافة مصفوفة variants وهمية لتجنب أخطاء الواجهة
    const formattedProducts = products.map((p) => ({
      ...p,
      variants: [{ images: [p.image_url] }],
    }));

    res.status(200).json(formattedProducts);
  } catch (error) {
    console.error("Error fetching products for tagging:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// --- الدوال الجديدة التي أضفناها للصفحة الرئيسية ---

// @desc    Get new arrival products
// @route   GET /api/browse/new-arrivals
// @access  Public
exports.getNewArrivals = asyncHandler(async (req, res) => {
  // الخطوة 1: جلب IDs المنتجات الأحدث
  const [productRows] = await pool.query(`
    SELECT id FROM products 
    WHERE status = 'active' 
    ORDER BY created_at DESC 
    LIMIT 10
  `);

  // الخطوة 2: جلب البيانات الكاملة لهذه IDs
  const fullProducts = await fetchFullProductData(productRows);
  res.status(200).json(fullProducts);
});

// @desc    Get best-selling products
// @route   GET /api/browse/best-sellers
// @access  Public
exports.getBestSellers = asyncHandler(async (req, res) => {
  // الخطوة 1: جلب IDs المنتجات الأكثر مبيعاً
  const [productRows] = await pool.query(`
    SELECT 
      oi.product_id as id, 
      COUNT(oi.product_id) as sales_count
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE p.status = 'active'
    GROUP BY oi.product_id
    ORDER BY sales_count DESC
    LIMIT 10
  `);

  // الخطوة 2: جلب البيانات الكاملة لهذه IDs
  const fullProducts = await fetchFullProductData(productRows);
  res.status(200).json(fullProducts);
});

// @desc    Get top-rated products
// @route   GET /api/browse/top-rated
// @access  Public
exports.getTopRated = asyncHandler(async (req, res) => {
  // الخطوة 1: جلب IDs المنتجات الأعلى تقييماً
  const [productRows] = await pool.query(`
    SELECT 
      product_id as id, 
      AVG(rating) as avg_rating
    FROM product_reviews
    GROUP BY product_id
    HAVING COUNT(id) > 0 -- (على الأقل تقييم واحد)
    ORDER BY avg_rating DESC
    LIMIT 10
  `);

  // الخطوة 2: جلب البيانات الكاملة لهذه IDs
  const fullProducts = await fetchFullProductData(productRows);
  res.status(200).json(fullProducts);
});

// @desc    Get top merchants
exports.getTopModels = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const currentUserId = req.user ? req.user.id : null; // ✅ معرفة المستخدم الحالي

  const query = `
    SELECT 
      u.id, 
      u.name, 
      u.profile_picture_url, 
      
      (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) as followers,
      (SELECT COALESCE(AVG(rating), 0) FROM agreement_reviews WHERE reviewee_id = u.id) as rating,
      
      -- ✅ هل أتابع هذا الشخص؟
      ${
        currentUserId
          ? `(SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = u.id) > 0`
          : "FALSE"
      } as isFollowedByMe

    FROM users u
    WHERE u.role_id = 3 
    AND u.is_banned = 0
    ORDER BY followers DESC
    LIMIT ?;
  `;

  // نمرر currentUserId إذا وجد، ثم limit
  const params = currentUserId ? [currentUserId, limit] : [limit];
  const [models] = await pool.query(query, params);

  const formattedModels = models.map((model) => ({
    ...model,
    followers: Number(model.followers),
    rating: Number(model.rating) > 0 ? Number(model.rating).toFixed(1) : "5.0",
    isFollowedByMe: Boolean(model.isFollowedByMe), // ✅ تحويل لـ Boolean
  }));

  res.status(200).json(formattedModels);
});

// @desc    Get top merchants
// @route   GET /api/browse/top-merchants
exports.getTopMerchants = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const currentUserId = req.user ? req.user.id : null;

  const query = `
    SELECT 
      u.id, 
      u.name, 
      u.store_name,
      u.profile_picture_url,
      
      (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) as followers,
      (
        SELECT COALESCE(AVG(pr.rating), 0) 
        FROM product_reviews pr 
        JOIN products p ON pr.product_id = p.id 
        WHERE p.merchant_id = u.id
      ) as rating,

      -- ✅ هل أتابع هذا التاجر؟
      ${
        currentUserId
          ? `(SELECT COUNT(*) FROM user_follows WHERE follower_id = ? AND following_id = u.id) > 0`
          : "FALSE"
      } as isFollowedByMe

    FROM users u
    WHERE u.role_id = 2
    AND u.is_banned = 0
    ORDER BY followers DESC
    LIMIT ?;
  `;

  const params = currentUserId ? [currentUserId, limit] : [limit];
  const [merchants] = await pool.query(query, params);

  const formattedMerchants = merchants.map((merchant) => ({
    ...merchant,
    followers: Number(merchant.followers),
    rating:
      Number(merchant.rating) > 0 ? Number(merchant.rating).toFixed(1) : "New",
    isFollowedByMe: Boolean(merchant.isFollowedByMe), // ✅ تحويل لـ Boolean
  }));

  res.status(200).json(formattedMerchants);
});
