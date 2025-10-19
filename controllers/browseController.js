// backend/controllers/browseController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
// [GET] جلب قائمة بكل العارضات والمؤثرات مع بياناتهن الأساسية
exports.getAllModels = async (req, res) => {
  try {
    const [models] = await pool.query(
      `SELECT id, name, role_id, profile_picture_url, bio, stats 
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
  // ✅ [FIXED] This query now correctly fetches 'compare_at_price' for the cheapest variant,
  // enabling discount calculations on the frontend.
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
    const [[category]] = await pool.query("SELECT id, name, description FROM categories WHERE slug = ?", [slug]);

    if (!category) {
        return res.status(404).json({ message: "Category not found" });
    }

    // 2. جلب المنتجات المرتبطة بهذا التصنيف
    const [products] = await pool.query(`
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
    `, [category.id]);

    // معالجة الصور لضمان إرسال صورة واحدة فقط
    const processedProducts = products.map(p => {
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