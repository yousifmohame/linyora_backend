const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

/**
 * @desc    Fetch all products with advanced filtering, sorting, and pagination.
 * @route   GET /api/products
 * @access  Public
 */
exports.getAllProducts = asyncHandler(async (req, res) => {
  try {
    const {
      categoryId,
      price_min,
      price_max,
      brands, // سيتم إرسالها كـ "brand1,brand2"
      rating,
      color,
      sortBy, // e.g., 'price_asc', 'price_desc', 'latest'
    } = req.query;

    let queryParams = [];
    let productIdsInScope;

    // --- بناء الجزء الأساسي من الاستعلام مع الفلاتر ---
    // سنقوم بفلترة معرّفات المنتجات أولاً، ثم جلب تفاصيلها. هذا أكثر كفاءة.
    let filterQuery = `
            SELECT DISTINCT p.id 
            FROM products p
            LEFT JOIN product_categories pc ON p.id = pc.product_id
            LEFT JOIN product_variants pv ON p.id = pv.product_id
        `;

    const whereClauses = ["p.status = 'active'"];

    // فلتر الفئة
    if (categoryId) {
      whereClauses.push(`pc.category_id = ?`);
      queryParams.push(categoryId);
    }

    // فلتر السعر
    if (price_min) {
      whereClauses.push(`pv.price >= ?`);
      queryParams.push(price_min);
    }
    if (price_max) {
      whereClauses.push(`pv.price <= ?`);
      queryParams.push(price_max);
    }

    // فلتر الماركة (يدعم عدة ماركات)
    if (brands) {
      const brandList = brands.split(",");
      whereClauses.push(`p.brand IN (?)`);
      queryParams.push(brandList);
    }

    // فلتر اللون والحجم (من المتغيرات)
    if (color) {
      whereClauses.push(`pv.color = ?`);
      queryParams.push(color);
    }

    if (whereClauses.length > 0) {
      filterQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    // تنفيذ استعلام الفلترة للحصول على IDs المنتجات
    const [productIdsResult] = await pool.query(filterQuery, queryParams);
    productIdsInScope = productIdsResult.map((p) => p.id);

    if (productIdsInScope.length === 0) {
      return res.status(200).json([]);
    }

    // --- جلب بيانات المنتجات الكاملة بناءً على IDs المفلترة ---
    let dataQuery = `
            SELECT 
                p.id, p.name, p.description, p.brand, p.status,
                u.store_name as merchantName,
                (SELECT AVG(rating) FROM product_reviews WHERE product_id = p.id) as rating,
                (SELECT COUNT(*) FROM product_reviews WHERE product_id = p.id) as reviewCount,
                (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) as min_price
            FROM products p
            JOIN users u ON p.merchant_id = u.id
            WHERE p.id IN (?)
        `;

    // فلتر التقييم (يطبق بعد جلب المنتجات)
    if (rating) {
      dataQuery += ` HAVING rating >= ?`;
    }

    // الترتيب
    switch (sortBy) {
      case "price_asc":
        dataQuery += " ORDER BY min_price ASC";
        break;
      case "price_desc":
        dataQuery += " ORDER BY min_price DESC";
        break;
      case "latest":
      default:
        dataQuery += " ORDER BY p.created_at DESC";
        break;
    }

    // إضافة `rating` إلى queryParams إذا كان موجودًا
    const finalQueryParams = [productIdsInScope];
    if (rating) {
      finalQueryParams.push(rating);
    }

    const [products] = await pool.query(dataQuery, finalQueryParams);

    // جلب المتغيرات للمنتجات المفلترة
    const [variants] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id IN (?) AND stock_quantity > 0",
      [productIdsInScope]
    );
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

    // دمج البيانات النهائية
    const productsWithData = products.map((product) => ({
      ...product,
      variants: variantsMap.get(product.id) || [],
      rating: parseFloat(product.rating) || 0,
      reviewCount: parseInt(product.reviewCount, 10) || 0,
    }));

    res.status(200).json(productsWithData);
  } catch (error) {
    console.error("Failed to fetch filtered products:", error);
    res.status(500).json({ message: "Error fetching products." });
  }
});

/**
 * [GET] A fallback function for older MySQL/MariaDB versions that don't support JSON_ARRAYAGG.
 */
exports.getAllProductsCompatible = async (req, res) => {
  try {
    // Step 1: Get all active base products
    const [products] = await pool.query(`
            SELECT p.id, p.name, p.description, p.brand, p.status, u.store_name as merchantName
            FROM products p
            JOIN users u ON p.merchant_id = u.id
            WHERE p.status = 'active'
        `);

    if (products.length === 0) return res.status(200).json([]);

    const productIds = products.map((p) => p.id);

    // Step 2: Get all variants for those products that are in stock
    const [variants] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id IN (?) AND stock_quantity > 0",
      [productIds]
    );

    // Group variants by their product_id
    const variantsMap = new Map();
    variants.forEach((variant) => {
      variant.images =
        typeof variant.images === "string" ? JSON.parse(variant.images) : [];
      const items = variantsMap.get(variant.product_id) || [];
      items.push(variant);
      variantsMap.set(variant.product_id, items);
    });

    // Combine products with their variants
    const productsWithVariants = products
      .map((product) => ({
        ...product,
        variants: variantsMap.get(product.id) || [],
      }))
      .filter((p) => p.variants.length > 0); // Filter out products with no in-stock variants

    res.status(200).json(productsWithVariants);
  } catch (error) {
    console.error("Failed to fetch public products (compatible mode):", error);
    res.status(500).json({ message: "Error fetching products." });
  }
};

/**
 * [GET] Fetches a single product by its ID, along with all its variants.
 */
exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    // جلب المنتج الأساسي وبيانات التاجر
    const [productResult] = await pool.query(
      `
            SELECT p.id, p.name, p.description, p.brand, u.store_name as merchantName
            FROM products p
            JOIN users u ON p.merchant_id = u.id
            WHERE p.id = ? AND p.status = 'active';
        `,
      [id]
    );

    if (productResult.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }
    const product = productResult[0];

    // جلب جميع متغيرات المنتج المتاحة
    const [variants] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id = ? AND stock_quantity > 0",
      [id]
    );

    product.variants = variants.map((v) => ({
      ...v,
      images: typeof v.images === "string" ? JSON.parse(v.images) : [],
    }));

    // ✨ جلب تقييمات المنتج مع أسماء المستخدمين
    let reviews = [];
    try {
      const [reviewsResult] = await pool.query(
        `
                SELECT r.id, r.rating, r.comment, r.created_at, u.name as userName
                FROM product_reviews r
                JOIN users u ON r.user_id = u.id
                WHERE r.product_id = ?
                ORDER BY r.created_at DESC
            `,
        [id]
      );
      reviews = reviewsResult;
    } catch (e) {
      console.log(
        "Could not fetch reviews for product, table might not exist."
      );
    }
    product.reviews = reviews;

    res.status(200).json(product);
  } catch (error) {
    console.error("Failed to fetch single product:", error);
    res.status(500).json({ message: "Error fetching product details." });
  }
};

/**
 * @desc    Get public details for a single product, including correct shipping companies.
 * @route   GET /api/products/:id/details
 * @access  Public
 */
exports.getProductDetailsWithShipping = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // ✅ FIX: The query is now more robust. It uses MAX() to ensure that if any
  // variant of a product is a dropshipping item, the supplier_id is correctly identified.
  const [[product]] = await pool.query(
    `SELECT 
            p.*, 
            MAX(sp.supplier_id) AS supplier_id 
         FROM products p
         LEFT JOIN product_variants pv ON p.id = pv.product_id
         LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
         LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
         LEFT JOIN supplier_products sp ON spv.product_id = sp.id
         WHERE p.id = ? AND p.status = 'active'
         GROUP BY p.id`,
    [id]
  );

  if (!product) {
    return res.status(404).json({ message: "لم يتم العثور على المنتج." });
  }

  const [variants] = await pool.query(
    "SELECT * FROM product_variants WHERE product_id = ?",
    [id]
  );

  // This logic is now reliable because the query is fixed.
  // If it's a dropship item, ownerId will be the supplier's ID. Otherwise, the merchant's.
  const ownerId = product.supplier_id || product.merchant_id;

  const [shippingCompanies] = await pool.query(
    "SELECT id, name, shipping_cost FROM shipping_companies WHERE merchant_id = ? AND is_active = 1",
    [ownerId]
  );

  res.status(200).json({
    ...product,
    variants: variants.map((v) => ({
      ...v,
      images: JSON.parse(v.images || "[]"),
    })),
    shipping_options: shippingCompanies,
  });
});

/**
 * @desc    Get consolidated shipping options for a list of products in a cart.
 * @route   POST /api/products/shipping-options-for-cart
 * @access  Private
 */
exports.getShippingOptionsForCart = asyncHandler(async (req, res) => {
  const { productIds } = req.body;

  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ message: "Product IDs are required." });
  }

  // ✅ FIX: This query also uses MAX() to be robust against product edits.
  const [products] = await pool.query(
    `SELECT 
            p.id,
            p.merchant_id,
            MAX(sp.supplier_id) AS supplier_id 
         FROM products p
         LEFT JOIN product_variants pv ON p.id = pv.product_id
         LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
         LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
         LEFT JOIN supplier_products sp ON spv.product_id = sp.id
         WHERE p.id IN (?)
         GROUP BY p.id`,
    [productIds]
  );

  const ownerIds = new Set();
  products.forEach((p) => {
    const owner = p.supplier_id || p.merchant_id;
    if (owner) {
      ownerIds.add(owner);
    }
  });

  // Logic to ensure all cart items can be shipped from a single source
  if (ownerIds.size > 1) {
    return res.status(200).json([]);
  }

  if (ownerIds.size === 0) {
    return res
      .status(404)
      .json({ message: "Could not determine a shipping owner." });
  }

  const [singleOwnerId] = ownerIds;
  const [shippingCompanies] = await pool.query(
    "SELECT id, name, shipping_cost FROM shipping_companies WHERE merchant_id = ? AND is_active = 1",
    [singleOwnerId]
  );

  res.status(200).json(shippingCompanies);
});

/**
 * @desc    Fetch all actively promoted products
 * @route   GET /api/products/promoted
 * @access  Public
 */
exports.getPromotedProducts = asyncHandler(async (req, res) => {
  const [products] = await pool.query(`
        SELECT
            p.id,
            p.name,
            (SELECT MIN(pv.price) FROM product_variants pv WHERE pv.product_id = p.id AND pv.stock_quantity > 0) as price,
            (SELECT MIN(pv.compare_at_price) FROM product_variants pv WHERE pv.product_id = p.id AND pv.stock_quantity > 0 AND pv.compare_at_price > 0) as original_price,
            (SELECT ((MIN(pv.compare_at_price) - MIN(pv.price)) / MIN(pv.compare_at_price)) * 100
             FROM product_variants pv
             WHERE pv.product_id = p.id AND pv.stock_quantity > 0 AND pv.compare_at_price IS NOT NULL AND pv.compare_at_price > pv.price) as discount_percentage,
            (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]')) FROM product_variants pv WHERE pv.product_id = p.id ORDER BY pv.id LIMIT 1) as image_url
        FROM products p
        JOIN product_promotions promo ON p.id = promo.product_id
        WHERE promo.status = 'active' AND NOW() BETWEEN promo.start_date AND promo.end_date AND p.status = 'active'
        ORDER BY promo.created_at DESC
        LIMIT 10
    `);

  const validProducts = products.filter(
    (p) => p.price !== null && p.image_url !== null
  );

  res.status(200).json(validProducts);
});

/**
 * @desc    Get available filter options like brands, colors, sizes.
 * @route   GET /api/products/filters
 * @access  Public
 */
exports.getFilterOptions = asyncHandler(async (req, res) => {
  try {
    const [brands] = await pool.query(
      "SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != '' ORDER BY brand ASC"
    );
    const [colors] = await pool.query(
      "SELECT DISTINCT color FROM product_variants WHERE color IS NOT NULL AND color != '' ORDER BY color ASC"
    );

    res.status(200).json({
      brands: brands.map((b) => b.brand),
      colors: colors.map((c) => c.color),
    });
  } catch (error) {
    console.error("Failed to fetch filter options:", error);
    res.status(500).json({ message: "Error fetching filter options." });
  }
});

/**
 * @desc    Search for products by name, brand, or description.
 * @route   GET /api/products/search
 * @access  Public
 */
exports.searchProducts = asyncHandler(async (req, res) => {
    const { term } = req.query;

    if (!term || term.trim() === '') {
        return res.status(200).json([]);
    }

    const searchTerm = `%${term}%`;

    // This query searches the term in product name, brand, and description.
    // It also fetches the price and image for the search results display.
    const [products] = await pool.query(
        `
        SELECT
            p.id,
            p.name,
            p.brand,
            (SELECT MIN(pv.price) FROM product_variants pv WHERE pv.product_id = p.id AND pv.stock_quantity > 0) as price,
            (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]')) FROM product_variants pv WHERE pv.product_id = p.id ORDER BY pv.id LIMIT 1) as image_url
        FROM products p
        WHERE 
            p.status = 'active' AND
            (p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)
        ORDER BY p.name ASC
        LIMIT 7
        `,
        [searchTerm, searchTerm, searchTerm]
    );

    const validProducts = products.filter(p => p.price !== null && p.image_url !== null);

    res.status(200).json(validProducts);
});