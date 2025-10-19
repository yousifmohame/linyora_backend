const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

/**
 * @desc    Supplier submits their data for verification
 * @route   POST /api/supplier/verification
 * @access  Private (Supplier)
 */
exports.submitVerification = async (req, res) => {
  const supplierId = req.user.id;
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
        supplierId,
      ]
    );

    await connection.query(
      `INSERT INTO merchant_bank_details (user_id, account_number, iban, iban_certificate_url) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
                account_number = VALUES(account_number), 
                iban = VALUES(iban), 
                iban_certificate_url = VALUES(iban_certificate_url)`,
      [supplierId, account_number, iban, files.iban_certificate[0].path]
    );

    await connection.commit();
    res.status(200).json({
      message: "تم تقديم بيانات التوثيق بنجاح وهي الآن قيد المراجعة.",
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error submitting supplier verification:", error);
    res.status(500).json({ message: "فشل في تقديم بيانات التوثيق." });
  } finally {
    connection.release();
  }
};

/**
 * @desc    Get dashboard statistics for the current supplier
 * @route   GET /api/supplier/dashboard
 * @access  Private (Verified Supplier)
 */
exports.getSupplierDashboardStats = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  try {
    // ✅ FIX: The subquery for 'total_orders' has been completely rewritten
    // to use the new, correct database structure with dropship_links.
    const [stats] = await pool.query(
      `SELECT
                (SELECT COUNT(*) FROM supplier_products WHERE supplier_id = ?) as total_products,
                
                (SELECT COUNT(DISTINCT o.id) 
                    FROM orders o
                    JOIN order_items oi ON o.id = oi.order_id
                    JOIN product_variants pv ON oi.product_variant_id = pv.id
                    JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
                    JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
                    WHERE spv.product_id IN (SELECT id FROM supplier_products WHERE supplier_id = ?)) as total_orders,

                (SELECT COALESCE(SUM(amount), 0) 
                    FROM wallet_transactions 
                    WHERE user_id = ? AND type = 'earning') as total_earnings
            `,
      [supplierId, supplierId, supplierId]
    );

    res.json({
      totalProducts: stats[0].total_products || 0,
      totalOrders: stats[0].total_orders || 0,
      // We now read from wallet_transactions for consistency
      totalEarnings: parseFloat(stats[0].total_earnings || 0).toFixed(2),
    });
  } catch (error) {
    console.error("Error fetching supplier dashboard stats:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching dashboard stats." });
  }
});
// ✨ --- END: CORRECTED FUNCTION --- ✨

/**
 * @desc    Create a new supplier product
 * @route   POST /api/supplier/products
 * @access  Private/Supplier
 */
exports.createSupplierProduct = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { name, brand, description, variants, categoryIds } = req.body;

  if (!name || !variants || !Array.isArray(variants) || variants.length === 0) {
    res.status(400);
    throw new Error("Product name and at least one variant are required.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [productResult] = await connection.query(
      "INSERT INTO supplier_products (supplier_id, name, brand, description) VALUES (?, ?, ?, ?)",
      [supplierId, name, brand, description]
    );
    const productId = productResult.insertId;

    for (const variant of variants) {
      const [variantResult] = await connection.query(
        "INSERT INTO supplier_product_variants (product_id, color, cost_price, stock_quantity, sku) VALUES (?, ?, ?, ?, ?)",
        [
          productId,
          variant.color,
          variant.cost_price,
          variant.stock_quantity,
          variant.sku,
        ]
      );
      const variantId = variantResult.insertId;

      if (variant.images && variant.images.length > 0) {
        const imageValues = variant.images.map((url) => [variantId, url]);
        await connection.query(
          "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
          [imageValues]
        );
      }
    }

    if (categoryIds && categoryIds.length > 0) {
      const categoryValues = categoryIds.map((catId) => [productId, catId]);
      await connection.query(
        "INSERT INTO supplier_product_categories (product_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await connection.commit();
    res
      .status(201)
      .json({ message: "Product created successfully!", productId });
  } catch (error) {
    await connection.rollback();
    console.error("Error creating supplier product:", error);
    res.status(500).json({
      message: "Failed to create product. The operation was rolled back.",
    });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Get all products for the logged-in supplier (Compatible & Optimized)
 * @route   GET /api/supplier/products
 * @access  Private/Supplier
 */
exports.getSupplierProducts = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;

  // ✅ FIX: Replaced JSON_ARRAYAGG with GROUP_CONCAT for MariaDB 10.4 compatibility.
  const [products] = await pool.query(
    `
    SELECT
        p.id, p.name, p.brand, p.description, p.is_active, p.created_at,
        GROUP_CONCAT(DISTINCT v.id SEPARATOR ',') AS variant_ids,
        GROUP_CONCAT(DISTINCT v.sku SEPARATOR ',') AS variant_skus,
        GROUP_CONCAT(DISTINCT v.color SEPARATOR ',') AS variant_colors,
        GROUP_CONCAT(DISTINCT v.cost_price SEPARATOR ',') AS variant_cost_prices,
        GROUP_CONCAT(DISTINCT v.stock_quantity SEPARATOR ',') AS variant_stocks,
        GROUP_CONCAT(DISTINCT CONCAT(v.id, '::', vi.image_url) SEPARATOR '|||') AS variant_images,
        GROUP_CONCAT(DISTINCT pc.category_id SEPARATOR ',') AS category_ids
    FROM supplier_products p
    LEFT JOIN supplier_product_variants v ON p.id = v.product_id
    LEFT JOIN supplier_variant_images vi ON v.id = vi.variant_id
    LEFT JOIN supplier_product_categories pc ON p.id = pc.product_id
    WHERE p.supplier_id = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC;
    `,
    [supplierId]
  );

  // Manually parse the GROUP_CONCAT strings into a structured JSON response
  const formattedProducts = products.map((p) => {
    const variantIds = p.variant_ids ? p.variant_ids.split(",") : [];
    const variantSkus = p.variant_skus ? p.variant_skus.split(",") : [];
    const variantColors = p.variant_colors ? p.variant_colors.split(",") : [];
    const variantCostPrices = p.variant_cost_prices
      ? p.variant_cost_prices.split(",")
      : [];
    const variantStocks = p.variant_stocks ? p.variant_stocks.split(",") : [];
    const variantImagesStr = p.variant_images
      ? p.variant_images.split("|||")
      : [];
    const categoryIds = p.category_ids
      ? p.category_ids.split(",").map(Number)
      : [];

    const variants = variantIds.map((id, index) => {
      const images = variantImagesStr
        .filter((img) => img.startsWith(id + "::"))
        .map((img) => img.split("::")[1]);

      return {
        id: Number(id),
        sku: variantSkus[index],
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
      is_active: p.is_active,
      created_at: p.created_at,
      variants: variants,
      categoryIds: categoryIds,
    };
  });

  res.status(200).json(formattedProducts);
});

/**
 * @desc    Update a supplier's product with variants and categories
 * @route   PUT /api/supplier/products/:id
 * @access  Private/Supplier
 */
exports.updateSupplierProduct = asyncHandler(async (req, res) => {
  const { id: productId } = req.params;
  const supplierId = req.user.id;
  const { name, brand, description, variants, categoryIds } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Verify this product actually belongs to the supplier
    const [[productCheck]] = await connection.query(
      "SELECT id FROM supplier_products WHERE id = ? AND supplier_id = ?",
      [productId, supplierId]
    );

    if (!productCheck) {
      await connection.rollback();
      return res.status(404).json({
        message: "Product not found or you don't have permission to edit it.",
      });
    }

    // 2. Update main product details
    await connection.query(
      "UPDATE supplier_products SET name = ?, brand = ?, description = ? WHERE id = ?",
      [name, brand, description, productId]
    );

    // --- Full Variant Synchronization Logic for the Supplier ---
    const [existingVariants] = await connection.query(
      "SELECT id FROM supplier_product_variants WHERE product_id = ?",
      [productId]
    );
    const existingVariantIds = existingVariants.map((v) => v.id);
    const submittedVariantIds = variants.map((v) => v.id).filter(Boolean);

    const variantsToDelete = existingVariantIds.filter(
      (id) => !submittedVariantIds.includes(id)
    );
    if (variantsToDelete.length > 0) {
      // This will cascade and delete images due to DB constraints
      await connection.query(
        "DELETE FROM supplier_product_variants WHERE id IN (?)",
        [variantsToDelete]
      );
    }

    for (const variant of variants) {
      if (variant.id && submittedVariantIds.includes(variant.id)) {
        // Update existing variant
        await connection.query(
          "UPDATE supplier_product_variants SET color = ?, cost_price = ?, stock_quantity = ?, sku = ? WHERE id = ?",
          [
            variant.color,
            variant.cost_price,
            variant.stock_quantity,
            variant.sku,
            variant.id,
          ]
        );
        // Resync images: delete old, insert new
        await connection.query(
          "DELETE FROM supplier_variant_images WHERE variant_id = ?",
          [variant.id]
        );
        if (variant.images && variant.images.length > 0) {
          const imageValues = variant.images.map((url) => [variant.id, url]);
          await connection.query(
            "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
            [imageValues]
          );
        }
      } else {
        // Insert new variant
        const [newVariantResult] = await connection.query(
          "INSERT INTO supplier_product_variants (product_id, color, cost_price, stock_quantity, sku) VALUES (?, ?, ?, ?, ?)",
          [
            productId,
            variant.color,
            variant.cost_price,
            variant.stock_quantity,
            variant.sku,
          ]
        );
        const newVariantId = newVariantResult.insertId;
        if (variant.images && variant.images.length > 0) {
          const imageValues = variant.images.map((url) => [newVariantId, url]);
          await connection.query(
            "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
            [imageValues]
          );
        }
      }
    }

    // --- Category Synchronization ---
    await connection.query(
      "DELETE FROM supplier_product_categories WHERE product_id = ?",
      [productId]
    );
    if (categoryIds && categoryIds.length > 0) {
      const categoryValues = categoryIds.map((catId) => [productId, catId]);
      await connection.query(
        "INSERT INTO supplier_product_categories (product_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await connection.commit();
    res.json({ message: "تم تحديث المنتج بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating supplier product:", error);
    res.status(500).json({ message: "Failed to update product." });
  } finally {
    connection.release();
  }
});
/**
 * @desc    Delete a supplier's product
 * @route   DELETE /api/supplier/products/:id
 * @access  Private (Verified Supplier)
 */
exports.deleteSupplierProduct = async (req, res) => {
  const { id } = req.params;
  const supplierId = req.user.id;

  try {
    const [result] = await pool.query(
      "DELETE FROM supplier_products WHERE id = ? AND supplier_id = ?",
      [id, supplierId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Product not found or you don't have permission to delete it.",
      });
    }
    res.json({ message: "Product deleted successfully." });
  } catch (error) {
    console.error("Error deleting supplier product:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getCategoriesForForm = asyncHandler(async (req, res) => {
  const [categories] = await pool.query(
    "SELECT id, name FROM categories WHERE parent_id IS NOT NULL ORDER BY name ASC"
  );
  res.json(categories);
});

/**
 * @desc    Get all orders containing the supplier's products
 * @route   GET /api/supplier/orders
 * @access  Private/Supplier
 */
exports.getSupplierOrders = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;

  const [orders] = await pool.query(
    `
        SELECT
            o.id AS order_id,
            o.created_at AS order_date,
            o.status AS order_status,
            o.shipping_cost,
            o.total_amount, 
            p.name AS product_name,
            pv.color AS variant_color,
            oi.quantity,
            spv.cost_price,
            (oi.quantity * spv.cost_price) AS total_cost,
            merch.store_name AS merchant_store_name,
            cust.name AS customer_name
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN product_variants pv ON oi.product_variant_id = pv.id
        JOIN products p ON pv.product_id = p.id
        JOIN users merch ON p.merchant_id = merch.id
        JOIN users cust ON o.customer_id = cust.id
        JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
        JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
        JOIN supplier_products sp ON spv.product_id = sp.id
        WHERE sp.supplier_id = ?
        ORDER BY o.created_at DESC;
        `,
    [supplierId]
  );

  res.status(200).json(orders);
});

/**
 * @desc    ✅ FIX: Get details for a single order for the supplier
 * @route   GET /api/supplier/orders/:id
 * @access  Private/Supplier
 */
exports.getSupplierOrderDetails = asyncHandler(async (req, res) => {
    const { id: orderId } = req.params;
    const supplierId = req.user.id;

    try {
        // --- Step 1: Authorization Check ---
        const [authCheck] = await pool.query(
            `SELECT oi.id 
             FROM order_items oi
             JOIN product_variants pv ON oi.product_variant_id = pv.id
             JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
             JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
             WHERE oi.order_id = ? AND spv.product_id IN (SELECT id FROM supplier_products WHERE supplier_id = ?) 
             LIMIT 1`,
            [orderId, supplierId]
        );

        if (authCheck.length === 0) {
            return res.status(404).json({ message: "الطلب غير موجود أو لا يخصك." });
        }

        // --- Step 2: Fetch All Order Details (including payment_method) ---
        const [[order]] = await pool.query(
            `SELECT
                o.id, o.created_at, o.status, o.shipping_cost, o.total_amount, o.payment_method,
                cust.name AS customer_name, cust.email AS customer_email,
                addr.full_name as shipping_name, addr.address_line_1, addr.city, addr.country, addr.phone_number as shipping_phone
            FROM orders o
            JOIN users cust ON o.customer_id = cust.id
            LEFT JOIN addresses addr ON o.shipping_address_id = addr.id
            WHERE o.id = ?`,
            [orderId]
        );

        // --- Step 3: Fetch ONLY the items belonging to this supplier ---
        const [items] = await pool.query(
            `SELECT 
                p.name AS product_name, pv.color AS variant_color, oi.quantity, spv.cost_price
            FROM order_items oi
            JOIN product_variants pv ON oi.product_variant_id = pv.id
            JOIN products p ON pv.product_id = p.id
            JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
            JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
            WHERE oi.order_id = ? AND spv.product_id IN (SELECT id FROM supplier_products WHERE supplier_id = ?)`,
            [orderId, supplierId]
        );

        // --- Step 4: Assemble the final response ---
        const orderDetails = {
            order_id: order.id,
            order_date: order.created_at,
            order_status: order.status,
            shipping_cost: order.shipping_cost,
            total_amount: order.total_amount,
            payment_method: order.payment_method, // Added payment method
            customer: { name: order.customer_name, email: order.customer_email },
            shipping_address: { name: order.shipping_name, address: order.address_line_1, city: order.city, country: order.country, phone: order.shipping_phone },
            items: items.map(item => ({
                name: item.product_name,
                color: item.variant_color,
                quantity: item.quantity,
                cost_price: item.cost_price,
                total_cost: item.quantity * item.cost_price,
            }))
        };

        res.status(200).json(orderDetails);
    } catch (error) {
        console.error("❌ [ORDERS] Error fetching supplier order details:", error);
        res.status(500).json({ message: "حدث خطأ أثناء جلب تفاصيل الطلب." });
    }
});

/**
 * @desc    Allows a supplier to update the status of an order they are involved in.
 * @route   PUT /api/supplier/orders/:id/status
 * @access  Private/Supplier
 */
exports.updateSupplierOrderStatus = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  const { status } = req.body;
  const supplierId = req.user.id;

  const validStatuses = ["processing", "shipped", "completed", "cancelled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "حالة الطلب غير صالحة." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Authorization Check: Verify this supplier is part of the order.
    const [authItems] = await connection.query(
      `SELECT oi.id 
             FROM order_items oi
             JOIN product_variants pv ON oi.product_variant_id = pv.id
             JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
             JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
             JOIN supplier_products sp ON spv.product_id = sp.id
             WHERE oi.order_id = ? AND sp.supplier_id = ?`,
      [orderId, supplierId]
    );

    if (authItems.length === 0) {
      await connection.rollback();
      return res
        .status(403)
        .json({
          message: "لا تملك صلاحية تعديل هذا الطلب لأنه لا يحتوي على منتجاتك.",
        });
    }

    // 2. Update the order status
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      orderId,
    ]);

    // ✅ FIX: START OF THE NEW EARNINGS PROCESSING LOGIC
    if (status === "completed") {
      console.log(
        `[Earnings] Order #${orderId} marked as 'completed'. Starting earnings release process.`
      );

      // a) Check if earnings have already been cleared to prevent double processing
      const [[order]] = await connection.query(
        "SELECT earnings_cleared FROM orders WHERE id = ? FOR UPDATE",
        [orderId]
      );

      if (order && !order.earnings_cleared) {
        // b) Find all pending transactions for this order
        const [pendingTransactions] = await connection.query(
          "SELECT id, user_id, amount FROM wallet_transactions WHERE related_entity_type = 'order' AND related_entity_id = ? AND status = 'pending_clearance'",
          [orderId]
        );

        if (pendingTransactions.length > 0) {
          console.log(
            `[Earnings] Found ${pendingTransactions.length} pending transaction(s) for order #${orderId}.`
          );

          // c) Update each transaction's status to 'cleared'
          for (const trx of pendingTransactions) {
            await connection.query(
              "UPDATE wallet_transactions SET status = 'cleared', cleared_at = NOW() WHERE id = ?",
              [trx.id]
            );
            console.log(
              `[Earnings] Transaction #${trx.id} for user #${trx.user_id} (Amount: ${trx.amount}) has been cleared.`
            );
          }

          // d) Mark the order as cleared to prevent this logic from running again
          await connection.query(
            "UPDATE orders SET earnings_cleared = TRUE WHERE id = ?",
            [orderId]
          );
          console.log(
            `[Earnings] Order #${orderId} has been marked as earnings_cleared.`
          );
        } else {
          console.log(
            `[Earnings] No pending transactions found for order #${orderId}. Nothing to clear.`
          );
        }
      } else {
        console.log(
          `[Earnings] Earnings for order #${orderId} have already been cleared. Skipping.`
        );
      }
    }
    // ✅ FIX: END OF THE NEW EARNINGS PROCESSING LOGIC

    // 3. Notify the customer about the status update
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
    console.error("Error updating supplier order status:", error);
    res.status(500).json({ message: "فشل في تحديث حالة الطلب." });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * @desc    Get supplier's wallet details and payout history
 * @route   GET /api/supplier/wallet
 * @access  Private/Supplier
 */
exports.getSupplierWallet = async (req, res) => {
  const supplierId = req.user.id;
  try {
    const query = `
            SELECT
                (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'cleared' AND type = 'earning') AS balance,
                (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'pending_clearance') AS pending_clearance
            FROM DUAL;
        `;
    const [[wallet]] = await pool.query(query, [supplierId, supplierId]);

    res.json({
      balance: parseFloat(wallet.balance).toFixed(2),
      pending_clearance: parseFloat(wallet.pending_clearance).toFixed(2),
    });
  } catch (error) {
    console.error("Error fetching supplier wallet data:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Request a payout from the supplier wallet
 * @route   POST /api/supplier/payout-request
 * @access  Private/Supplier
 */
exports.requestPayout = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }

  // Get current balance
  const [[wallet]] = await pool.query(
    "SELECT balance FROM supplier_wallets WHERE supplier_id = ?",
    [supplierId]
  );

  const currentBalance = wallet ? Number(wallet.balance) : 0;

  if (amount > currentBalance) {
    return res
      .status(400)
      .json({ message: "المبلغ المطلوب أكبر من رصيدك المتاح." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Deduct amount from balance
    await connection.query(
      "UPDATE supplier_wallets SET balance = balance - ? WHERE supplier_id = ?",
      [amount, supplierId]
    );

    // 2. Create a payout request record
    await connection.query(
      "INSERT INTO supplier_payout_requests (supplier_id, amount) VALUES (?, ?)",
      [supplierId, amount]
    );

    await connection.commit();
    res.status(201).json({ message: "تم إرسال طلب سحب الأرباح بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error requesting supplier payout:", error);
    res.status(500).json({ message: "حدث خطأ أثناء معالجة طلبك." });
  } finally {
    connection.release();
  }
});

/**
 * @desc    Get all shipping companies for the logged-in supplier
 * @route   GET /api/supplier/shipping
 * @access  Private/Supplier
 */
exports.getMyShippingCompanies = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const [companies] = await pool.query(
    // We use the 'merchant_id' column to store the user_id (supplier or merchant)
    "SELECT * FROM shipping_companies WHERE merchant_id = ? ORDER BY name ASC",
    [supplierId]
  );
  res.status(200).json(companies);
});

/**
 * @desc    Add a new shipping company for the logged-in supplier
 * @route   POST /api/supplier/shipping
 * @access  Private/Supplier
 */
exports.addMyShippingCompany = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { name, shipping_cost } = req.body;

  if (!name || !shipping_cost) {
    return res
      .status(400)
      .json({ message: "اسم الشركة وتكلفة الشحن مطلوبان." });
  }

  const [result] = await pool.query(
    "INSERT INTO shipping_companies (merchant_id, name, shipping_cost) VALUES (?, ?, ?)",
    [supplierId, name, shipping_cost]
  );
  res.status(201).json({ id: result.insertId, name, shipping_cost });
});

/**
 * @desc    Update a shipping company for the logged-in supplier
 * @route   PUT /api/supplier/shipping/:id
 * @access  Private/Supplier
 */
exports.updateMyShippingCompany = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { id } = req.params;
  const { name, shipping_cost } = req.body;

  if (!name || !shipping_cost) {
    return res
      .status(400)
      .json({ message: "اسم الشركة وتكلفة الشحن مطلوبان." });
  }

  await pool.query(
    "UPDATE shipping_companies SET name = ?, shipping_cost = ? WHERE id = ? AND merchant_id = ?",
    [name, shipping_cost, id, supplierId]
  );

  res.status(200).json({ message: "تم تحديث شركة الشحن بنجاح." });
});

/**
 * @desc    Delete a shipping company for the logged-in supplier
 * @route   DELETE /api/supplier/shipping/:id
 * @access  Private/Supplier
 */
exports.deleteMyShippingCompany = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { id } = req.params;

  const [result] = await pool.query(
    "DELETE FROM shipping_companies WHERE id = ? AND merchant_id = ?",
    [id, supplierId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "لم يتم العثور على شركة الشحن." });
  }

  res.status(200).json({ message: "تم حذف شركة الشحن بنجاح." });
});

/**
 * @desc    Get the profile settings for the logged-in supplier (Advanced Version)
 * @route   GET /api/supplier/settings
 * @access  Private/Supplier
 */
exports.getSupplierSettings = asyncHandler(async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT store_name, store_description, store_banner_url, social_links, notifications_prefs, privacy_prefs FROM users WHERE id = ?",
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
});

/**
 * @desc    Update the profile settings for the logged-in supplier (Advanced Version)
 * @route   PUT /api/supplier/settings
 * @access  Private/Supplier
 */
exports.updateSupplierSettings = asyncHandler(async (req, res) => {
  const {
    store_name,
    store_description,
    store_banner_url,
    social_links,
    notifications,
    privacy,
  } = req.body;
  try {
    await pool.query(
      "UPDATE users SET store_name = ?, store_description = ?, store_banner_url = ?, social_links = ?, notifications_prefs = ?, privacy_prefs = ? WHERE id = ?",
      [
        store_name,
        store_description,
        store_banner_url,
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
});
