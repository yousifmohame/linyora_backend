// linora-platform/backend/controllers/dropshippingController.js

const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

/**
 * @desc    Get all available supplier products for a merchant to browse.
 * @route   GET /api/dropshipping/products
 * @access  Private/Merchant
 */
exports.getAvailableProducts = asyncHandler(async (req, res) => {
  // This query fetches all active products from all suppliers.
  // It's similar to the one in supplierController but for a public browsing context.
  const [products] = await pool.query(
    `
    SELECT
        p.id, p.name, p.brand, p.description, p.created_at,
        s.store_name as supplier_name,
        GROUP_CONCAT(DISTINCT v.id SEPARATOR ',') AS variant_ids,
        GROUP_CONCAT(DISTINCT v.color SEPARATOR ',') AS variant_colors,
        GROUP_CONCAT(DISTINCT v.cost_price SEPARATOR ',') AS variant_cost_prices,
        GROUP_CONCAT(DISTINCT v.stock_quantity SEPARATOR ',') AS variant_stocks,
        GROUP_CONCAT(DISTINCT CONCAT(v.id, '::', vi.image_url) SEPARATOR '|||') AS variant_images,
        GROUP_CONCAT(DISTINCT c.name SEPARATOR ', ') AS categories
    FROM supplier_products p
    JOIN users s ON p.supplier_id = s.id
    LEFT JOIN supplier_product_variants v ON p.id = v.product_id
    LEFT JOIN supplier_variant_images vi ON v.id = vi.variant_id
    LEFT JOIN supplier_product_categories pc ON p.id = pc.product_id
    LEFT JOIN categories c ON pc.category_id = c.id
    WHERE p.is_active = 1 AND s.verification_status = 'approved'
    GROUP BY p.id
    ORDER BY p.created_at DESC;
    `
  );

  // Manually parse the GROUP_CONCAT strings into a structured JSON response
  const formattedProducts = products.map((p) => {
    const variantIds = p.variant_ids ? p.variant_ids.split(",") : [];
    const variantColors = p.variant_colors ? p.variant_colors.split(",") : [];
    const variantCostPrices = p.variant_cost_prices
      ? p.variant_cost_prices.split(",")
      : [];
    const variantStocks = p.variant_stocks ? p.variant_stocks.split(",") : [];
    const variantImagesStr = p.variant_images
      ? p.variant_images.split("|||")
      : [];

    const variants = variantIds.map((id, index) => {
      const images = variantImagesStr
        .filter((img) => img.startsWith(id + "::"))
        .map((img) => img.split("::")[1]);

      return {
        id: Number(id),
        color: variantColors[index],
        cost_price: parseFloat(variantCostPrices[index]),
        stock_quantity: parseInt(variantStocks[index], 10),
        images: images,
      };
    });

    return {
      id: p.id,
      name: p.name,
      brand: p.brand,
      description: p.description,
      supplier_name: p.supplier_name,
      created_at: p.created_at,
      categories: p.categories,
      variants: variants,
    };
  });

  res.status(200).json(formattedProducts);
});

/**
 * @desc    Merchant adds a supplier product to their own store.
 * @route   POST /api/dropshipping/add-product
 * @access  Private/Merchant
 */
exports.addProductToMerchantStore = asyncHandler(async (req, res) => {
  const merchantId = req.user.id;
  const { supplierProductId, salePrice, compareAtPrice } = req.body;

  if (!supplierProductId || !salePrice || isNaN(salePrice) || salePrice <= 0) {
    res.status(400);
    throw new Error("Product ID and a valid sale price are required.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Fetch supplier product and its variants
    const [[supplierProduct]] = await connection.query(
      "SELECT * FROM supplier_products WHERE id = ?",
      [supplierProductId]
    );
    const [supplierVariants] = await connection.query(
      "SELECT * FROM supplier_product_variants WHERE product_id = ?",
      [supplierProductId]
    );

    if (!supplierProduct || supplierVariants.length === 0) {
      await connection.rollback();
      res.status(404);
      throw new Error("Supplier product not found or has no variants.");
    }

    // 2. Create a new product for the merchant
    const [merchantProductResult] = await connection.query(
      "INSERT INTO products (merchant_id, name, description, brand, status) VALUES (?, ?, ?, ?, 'active')",
      [
        merchantId,
        supplierProduct.name,
        supplierProduct.description,
        supplierProduct.brand,
      ]
    );
    const merchantProductId = merchantProductResult.insertId;

    // 3. Copy variants, create dropship links, and copy images
    for (const supVariant of supplierVariants) {
      // Create a new variant for the merchant
      const [merchantVariantResult] = await connection.query(
        `INSERT INTO product_variants 
                    (product_id, color, price, compare_at_price, stock_quantity, sku) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
        [
          merchantProductId,
          supVariant.color,
          salePrice, // The sale price set by the merchant
          compareAtPrice || null,
          supVariant.stock_quantity, // Copy stock from supplier
          `DS-${merchantId}-${supVariant.id}`, // Generate a unique SKU
        ]
      );
      const merchantVariantId = merchantVariantResult.insertId;

      // 4. ✨ The most critical step: Create the link in our new table
      await connection.query(
        "INSERT INTO dropship_links (merchant_variant_id, supplier_variant_id) VALUES (?, ?)",
        [merchantVariantId, supVariant.id]
      );

      // 5. Copy images from supplier variant to merchant variant
      const [supplierImages] = await connection.query(
        "SELECT image_url FROM supplier_variant_images WHERE variant_id = ?",
        [supVariant.id]
      );
      if (supplierImages.length > 0) {
        // The 'images' column in product_variants is JSON
        const imageUrls = supplierImages.map((img) => img.image_url);
        await connection.query(
          "UPDATE product_variants SET images = ? WHERE id = ?",
          [JSON.stringify(imageUrls), merchantVariantId]
        );
      }
    }

    // 6. Copy categories
    const [supplierCategories] = await connection.query(
      "SELECT category_id FROM supplier_product_categories WHERE product_id = ?",
      [supplierProductId]
    );
    if (supplierCategories.length > 0) {
      const categoryValues = supplierCategories.map((cat) => [
        merchantProductId,
        cat.category_id,
      ]);
      await connection.query(
        "INSERT INTO product_categories (product_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await connection.commit();
    res
      .status(201)
      .json({
        message: "Product has been successfully added to your store.",
        productId: merchantProductId,
      });
  } catch (error) {
    await connection.rollback();
    console.error("Error adding product to merchant store:", error);
    res
      .status(500)
      .json({ message: "An error occurred while adding the product." });
  } finally {
    connection.release();
  }
});
