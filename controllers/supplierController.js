const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
const { recordTransaction } = require("./walletController");

/**
 * @desc    Supplier submits their data for verification
 * @route   POST /api/supplier/verification
 * @access  Private (Supplier)
 */
exports.submitVerification = async (req, res) => {
  const supplierId = req.user.id;

  // استقبال الحقول الجديدة (bank_name, account_holder_name) إذا توفرت
  const {
    identity_number,
    business_name,
    account_number,
    iban,
    bank_name,
    account_holder_name,
  } = req.body;

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
    // جلب اسم المستخدم لاستخدامه كاحتياط لاسم صاحب الحساب
    const [[user]] = await connection.query(
      "SELECT name FROM users WHERE id = ?",
      [supplierId],
    );

    // تحديد القيم الافتراضية للحقول الجديدة
    // للمورد: نفضل اسم صاحب الحساب القادم من الطلب > ثم اسم الشركة > ثم اسم المستخدم
    const finalAccountHolder =
      account_holder_name || business_name || user.name || "Unknown";
    const finalBankName = bank_name || "Bank";

    await connection.beginTransaction();

    // 1. تحديث بيانات المستخدم (الهوية والسجل التجاري)
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
      ],
    );

    // 2. إدخال أو تحديث البيانات في الجدول الموحد `bank_details`
    await connection.query(
      `INSERT INTO bank_details 
             (user_id, bank_name, account_holder_name, account_number, iban, iban_certificate_url, status, is_verified) 
            VALUES (?, ?, ?, ?, ?, ?, 'pending', 0) 
            ON DUPLICATE KEY UPDATE 
              bank_name = VALUES(bank_name),
              account_holder_name = VALUES(account_holder_name),
              account_number = VALUES(account_number), 
              iban = VALUES(iban), 
              iban_certificate_url = VALUES(iban_certificate_url),
              status = 'pending',
              is_verified = 0`,
      [
        supplierId,
        finalBankName, // الحقل الجديد
        finalAccountHolder, // الحقل الجديد
        account_number,
        iban,
        files.iban_certificate[0].path,
      ],
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
    const [stats] = await pool.query(
      `SELECT
            -- 1. عدد المنتجات
            (SELECT COUNT(*) FROM supplier_products WHERE supplier_id = ?) as total_products,
            
            -- 2. عدد الطلبات (التي تحتوي على منتجات هذا المورد)
            (SELECT COUNT(DISTINCT o.id) 
                FROM orders o
                JOIN order_items oi ON o.id = oi.order_id
                JOIN product_variants pv ON oi.product_variant_id = pv.id
                JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
                JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
                WHERE spv.product_id IN (SELECT id FROM supplier_products WHERE supplier_id = ?)) as total_orders,

            -- 3. ✅ الرصيد المتاح (تم التصحيح: القراءة من جدول wallets مباشرة)
            (SELECT COALESCE(balance, 0.00) FROM wallets WHERE user_id = ?) as current_balance
        `,
      // نمرر supplierId 3 مرات فقط الآن
      [supplierId, supplierId, supplierId],
    );

    // التحقق من وجود بيانات
    const data = stats[0] || {};

    res.json({
      totalProducts: Number(data.total_products || 0),
      totalOrders: Number(data.total_orders || 0),
      currentBalance: Number(data.current_balance || 0).toFixed(2),
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
      [supplierId, name, brand, description],
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
        ],
      );
      const variantId = variantResult.insertId;

      if (variant.images && variant.images.length > 0) {
        const imageValues = variant.images.map((url) => [variantId, url]);
        await connection.query(
          "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
          [imageValues],
        );
      }
    }

    if (categoryIds && categoryIds.length > 0) {
      const categoryValues = categoryIds.map((catId) => [productId, catId]);
      await connection.query(
        "INSERT INTO supplier_product_categories (product_id, category_id) VALUES ?",
        [categoryValues],
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
    [supplierId],
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
 * @desc    Update a supplier's product with variants and categories (With Merchant Sync)
 * @route   PUT /api/supplier/products/:id
 * @access  Private/Supplier
 */
exports.updateSupplierProduct = asyncHandler(async (req, res) => {
  const { id: productId } = req.params;
  const supplierId = req.user.id;
  const { name, brand, description, variants, categoryIds } = req.body;

  // حماية ضد البيانات الفارغة
  const safeVariants = Array.isArray(variants) ? variants : [];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. التحقق من ملكية المنتج
    const [[productCheck]] = await connection.query(
      "SELECT id FROM supplier_products WHERE id = ? AND supplier_id = ?",
      [productId, supplierId],
    );

    if (!productCheck) {
      await connection.rollback();
      return res.status(404).json({
        message: "المنتج غير موجود أو ليس لديك صلاحية تعديله.",
      });
    }

    // 2. تحديث البيانات الأساسية للمنتج
    await connection.query(
      "UPDATE supplier_products SET name = ?, brand = ?, description = ? WHERE id = ?",
      [name, brand, description, productId],
    );

    // ============================================================
    // 3. إدارة المتغيرات (Variants) مع المزامنة للتجار
    // ============================================================

    // جلب المتغيرات الحالية
    const [existingVariants] = await connection.query(
      "SELECT id FROM supplier_product_variants WHERE product_id = ?",
      [productId],
    );
    const existingVariantIds = existingVariants.map((v) => v.id);
    const submittedVariantIds = safeVariants.map((v) => v.id).filter(Boolean);

    // أ) حذف المتغيرات التي قام المورد بإزالتها
    const variantsToDelete = existingVariantIds.filter(
      (id) => !submittedVariantIds.includes(id),
    );

    if (variantsToDelete.length > 0) {
      // ⚠️ هام: قبل الحذف، يجب تعطيل متغيرات التجار المرتبطة بهذه المتغيرات
      // نجعل مخزون التاجر 0 للمتغيرات المحذوفة
      await connection.query(
        `
        UPDATE product_variants pv
        JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
        SET pv.stock_quantity = 0
        WHERE dl.supplier_variant_id IN (?)
      `,
        [variantsToDelete],
      );

      // حذف الرابط من جدول الدروبشيبينغ (اختياري، أو تركه للأرشيف)
      await connection.query(
        "DELETE FROM dropship_links WHERE supplier_variant_id IN (?)",
        [variantsToDelete],
      );

      // الآن نحذف متغير المورد
      await connection.query(
        "DELETE FROM supplier_product_variants WHERE id IN (?)",
        [variantsToDelete],
      );
    }

    // ب) إضافة أو تحديث المتغيرات
    for (const variant of safeVariants) {
      if (variant.id && submittedVariantIds.includes(variant.id)) {
        // --- تحديث متغير موجود ---
        await connection.query(
          "UPDATE supplier_product_variants SET color = ?, cost_price = ?, stock_quantity = ?, sku = ? WHERE id = ?",
          [
            variant.color,
            variant.cost_price,
            variant.stock_quantity,
            variant.sku,
            variant.id,
          ],
        );

        // 🔥🔥🔥 المزامنة الحية (Live Sync): تحديث مخزون التجار فوراً
        // لا نحدث السعر (price) لأن التاجر يضع سعره الخاص، لكن المخزون (stock) يجب أن يتطابق
        await connection.query(
          `
            UPDATE product_variants pv
            JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
            SET pv.stock_quantity = ? 
            WHERE dl.supplier_variant_id = ?
        `,
          [variant.stock_quantity, variant.id],
        );

        // تحديث الصور
        await connection.query(
          "DELETE FROM supplier_variant_images WHERE variant_id = ?",
          [variant.id],
        );
        if (variant.images && variant.images.length > 0) {
          const imageValues = variant.images.map((url) => [variant.id, url]);
          await connection.query(
            "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
            [imageValues],
          );
        }
      } else {
        // --- إضافة متغير جديد ---
        const [newVariantResult] = await connection.query(
          "INSERT INTO supplier_product_variants (product_id, color, cost_price, stock_quantity, sku) VALUES (?, ?, ?, ?, ?)",
          [
            productId,
            variant.color,
            variant.cost_price,
            variant.stock_quantity,
            variant.sku,
          ],
        );
        const newVariantId = newVariantResult.insertId;

        if (variant.images && variant.images.length > 0) {
          const imageValues = variant.images.map((url) => [newVariantId, url]);
          await connection.query(
            "INSERT INTO supplier_variant_images (variant_id, image_url) VALUES ?",
            [imageValues],
          );
        }

        // ملاحظة: المتغيرات الجديدة لن تظهر عند التاجر تلقائياً،
        // يجب على التاجر إعادة استيراد المنتج أو يتم إرسال إشعار له بوجود "موديلات جديدة".
      }
    }

    // 4. تحديث التصنيفات (Categories)
    await connection.query(
      "DELETE FROM supplier_product_categories WHERE product_id = ?",
      [productId],
    );
    if (categoryIds && categoryIds.length > 0) {
      const categoryValues = categoryIds.map((catId) => [productId, catId]);
      await connection.query(
        "INSERT INTO supplier_product_categories (product_id, category_id) VALUES ?",
        [categoryValues],
      );
    }

    // 5. (إضافي) إرسال إشعار للتجار المرتبطين (فكرة اختيارية)
    // يمكن هنا إضافة كود لإدخال إشعار في جدول notifications لكل تاجر يبيع هذا المنتج
    // "قام المورد بتحديث مواصفات المنتج X"

    await connection.commit();
    res.json({ message: "تم تحديث المنتج ومزامنة المخزون مع التجار بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error updating supplier product:", error);
    res.status(500).json({ message: "فشل تحديث المنتج." });
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
      [id, supplierId],
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
    "SELECT id, name FROM categories WHERE parent_id IS NOT NULL ORDER BY name ASC",
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
    [supplierId],
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
      [orderId, supplierId],
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
      [orderId],
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
      [orderId, supplierId],
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
      shipping_address: {
        name: order.shipping_name,
        address: order.address_line_1,
        city: order.city,
        country: order.country,
        phone: order.shipping_phone,
      },
      items: items.map((item) => ({
        name: item.product_name,
        color: item.variant_color,
        quantity: item.quantity,
        cost_price: item.cost_price,
        total_cost: item.quantity * item.cost_price,
      })),
    };

    res.status(200).json(orderDetails);
  } catch (error) {
    console.error("❌ [ORDERS] Error fetching supplier order details:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب تفاصيل الطلب." });
  }
});
// ===================================================================================
//  🔥 FINANCIAL ENGINE (النسخة الشاملة: تسجيل الخصومات في كل الحالات)
// ===================================================================================
const calculateAndRegisterEarnings = async (orderId, connection) => {
  console.log(`💰 [Finance] Starting Logic Calculation for Order #${orderId}`);

  // 1. بيانات الطلب الأساسية
  const [[orderMeta]] = await connection.query(
    "SELECT payment_method, shipping_cost, shipping_company_id FROM orders WHERE id = ?",
    [orderId],
  );

  const isCOD = orderMeta.payment_method === "cod";
  const globalShippingCost = Number(orderMeta.shipping_cost || 0);

  // 2. إعدادات المنصة
  const [settings] = await connection.query(
    "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN ('commission_rate', 'shipping_commission_rate', 'clearance_days')",
  );
  const config = settings.reduce((acc, row) => {
    acc[row.setting_key] = parseFloat(row.setting_value);
    return acc;
  }, {});

  const commissionRate = (config.commission_rate || 10) / 100;
  const shippingCommRate = (config.shipping_commission_rate || 10) / 100;
  const clearanceDays = config.clearance_days || 14;

  const availableAt = new Date();
  availableAt.setDate(availableAt.getDate() + clearanceDays);

  // 3. جلب تفاصيل العناصر
  const [items] = await connection.query(
    `SELECT oi.*, p.merchant_id, p.name as product_name, 
            sp.supplier_id, spv.cost_price 
     FROM order_items oi
     JOIN products p ON oi.product_id = p.id
     LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
     LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
     LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
     LEFT JOIN supplier_products sp ON spv.product_id = sp.id
     WHERE oi.order_id = ?`,
    [orderId],
  );

  // تحديد المورد الأساسي (مستخدم لأغراض الشحن)
  const firstSupplierItem = items.find((i) => i.supplier_id);
  const defaultShippingOwnerId = firstSupplierItem
    ? firstSupplierItem.supplier_id
    : items[0]?.merchant_id;

  // -------------------------------------------------------------
  // 🔥 المعالجة المالية للمنتجات (Product Processing)
  // -------------------------------------------------------------
  for (const item of items) {
    const qty = Number(item.quantity);
    const sellingPriceTotal = Number(item.price) * qty;

    if (item.supplier_id && item.cost_price) {
      // ✅ حالة الدروبشيبينغ (Dropshipping)
      const costPriceTotal = Number(item.cost_price) * qty;
      const supplierPlatformFee = costPriceTotal * commissionRate; // عمولة المنصة على المورد
      const grossProfit = sellingPriceTotal - costPriceTotal; // ربح التاجر
      const merchantPlatformFee = grossProfit * commissionRate; // عمولة المنصة على التاجر
      const netMerchantProfit = grossProfit - merchantPlatformFee; // صافي ربح التاجر

      if (isCOD) {
        // 🔥🔥 منطق COD الجديد (المورد معه الكاش) 🔥🔥

        // 1. المورد (معه الكاش): عليه مديونيات (عمولة المنصة + ربح التاجر)
        // نسجل عليه خصم فوري (Cleared Deduction) بقيمة إجمالي المبلغ الذي يجب أن يدفعه
        const totalDebtOnSupplier =
          supplierPlatformFee + netMerchantProfit + merchantPlatformFee;

        // تفصيل الديون على المورد:
        // أ) خصم عمولة المنصة الخاصة به
        await recordTransaction(
          {
            userId: item.supplier_id,
            amount: -supplierPlatformFee,
            type: "cod_commission_deduction",
            status: "cleared", // دين مستحق فوراً
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `خصم عمولة منصة (COD) - منتج: ${item.product_name}`,
            availableAt: null,
          },
          connection,
        );

        // ب) خصم قيمة ربح التاجر (لأن المورد أخذها كاش ويجب أن يعطيها للمنصة لتعطيها للتاجر)
        // ملاحظة: نسجلها كـ "تحويل مستحق للتاجر"
        await recordTransaction(
          {
            userId: item.supplier_id,
            amount: -grossProfit, // نسحب منه كامل الربح (شامل عمولة التاجر) لأن المنصة ستوزعها
            type: "merchant_profit_transfer",
            status: "cleared",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `تحويل مستحق للتاجر (COD) - منتج: ${item.product_name}`,
            availableAt: null,
          },
          connection,
        );

        // 2. التاجر (لم يستلم شيئاً): له أرباح (Pending)
        // نسجل له صافي الربح (بعد خصم عمولة المنصة منه)
        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: netMerchantProfit,
            type: "sale_earning", // ربح بيع
            status: "pending", // معلق حتى يسدد المورد أو تنتهي فترة الضمان
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `ربح دروبشيبينغ (COD) - منتج: ${item.product_name}`,
            availableAt,
          },
          connection,
        );

        // (اختياري) تسجيل عمولة المنصة على التاجر كقيد صوري للمحاسبة فقط
        // لا نخصمها من الرصيد هنا لأننا سجلنا "الصافي" للتاجر أعلاه
      } else {
        // ✅ حالة الدفع الإلكتروني (Visa/Card) - المنصة معها الكاش
        // المورد: له التكلفة - العمولة
        await recordTransaction(
          {
            userId: item.supplier_id,
            amount: costPriceTotal,
            type: "sale_earning",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `تكلفة منتج (Card): ${item.product_name}`,
            availableAt,
          },
          connection,
        );

        await recordTransaction(
          {
            userId: item.supplier_id,
            amount: -supplierPlatformFee,
            type: "commission_deduction",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `عمولة منصة: ${item.product_name}`,
            availableAt,
          },
          connection,
        );

        // التاجر: له الربح - العمولة
        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: grossProfit,
            type: "sale_earning",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `ربح بيع (Card): ${item.product_name}`,
            availableAt,
          },
          connection,
        );

        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: -merchantPlatformFee,
            type: "commission_deduction",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `عمولة منصة: ${item.product_name}`,
            availableAt,
          },
          connection,
        );
      }
    } else {
      // ✅ حالة التاجر العادي (منتج خاص به)
      const merchantCommission = sellingPriceTotal * commissionRate;

      if (isCOD) {
        // التاجر معه الكاش: نخصم منه العمولة فوراً (مديونية)
        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: -merchantCommission,
            type: "cod_commission_deduction",
            status: "cleared",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `عمولة منصة (COD): ${item.product_name}`,
            availableAt: null,
          },
          connection,
        );
      } else {
        // المنصة معها الكاش: إيداع للتاجر (معلق) ثم خصم عمولة (معلق)
        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: sellingPriceTotal,
            type: "sale_earning",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `مبيعات (Card): ${item.product_name}`,
            availableAt,
          },
          connection,
        );

        await recordTransaction(
          {
            userId: item.merchant_id,
            amount: -merchantCommission,
            type: "commission_deduction",
            status: "pending",
            paymentMethod: "system",
            referenceType: "order",
            referenceId: orderId,
            description: `عمولة منصة: ${item.product_name}`,
            availableAt,
          },
          connection,
        );
      }
    }
  }

  // -------------------------------------------------------------
  // 🔥 المعالجة المالية للشحن (Shipping Processing)
  // -------------------------------------------------------------

  const processShippingTransaction = async (ownerId, cost, descName) => {
    const shipFee = cost * shippingCommRate;

    if (isCOD) {
      // COD: صاحب شركة الشحن (غالباً المورد) استلم الكاش
      // نخصم منه عمولة المنصة على الشحن فوراً (مديونية)
      await recordTransaction(
        {
          userId: ownerId,
          amount: -shipFee,
          type: "cod_commission_deduction",
          status: "cleared",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `عمولة منصة على الشحن (COD) - ${descName}`,
          availableAt: null,
        },
        connection,
      );
    } else {
      // Card: المنصة معها الكاش
      // إيداع تكلفة الشحن للمورد (معلق) + خصم العمولة (معلق)
      await recordTransaction(
        {
          userId: ownerId,
          amount: cost,
          type: "shipping_earning",
          status: "pending",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `عائد شحن - ${descName}`,
          availableAt,
        },
        connection,
      );

      await recordTransaction(
        {
          userId: ownerId,
          amount: -shipFee,
          type: "commission_deduction",
          status: "pending",
          paymentMethod: "system",
          referenceType: "order",
          referenceId: orderId,
          description: `عمولة شحن - ${descName}`,
          availableAt,
        },
        connection,
      );
    }
  };

  // معالجة شركات الشحن (نفس المنطق القديم مع استدعاء الدالة المعدلة أعلاه)
  const [shippingSelections] = await connection.query(
    "SELECT * FROM order_shipping_selections WHERE order_id = ?",
    [orderId],
  );

  let shippingHandled = false;

  if (shippingSelections.length > 0) {
    for (const sel of shippingSelections) {
      const [[company]] = await connection.query(
        "SELECT shipping_cost, merchant_id as owner_id, name FROM shipping_companies WHERE id = ?",
        [sel.shipping_option_id],
      );
      if (company) {
        await processShippingTransaction(
          company.owner_id,
          Number(company.shipping_cost),
          company.name,
        );
        shippingHandled = true;
      }
    }
  }

  if (!shippingHandled && globalShippingCost > 0) {
    // تحديد من هو صاحب الشحن (في الغالب المورد في حالة الدروبشيبينغ)
    let shippingOwnerId = defaultShippingOwnerId;
    let companyName = "شحن عام";

    if (orderMeta.shipping_company_id) {
      const [[company]] = await connection.query(
        "SELECT merchant_id as owner_id, name FROM shipping_companies WHERE id = ?",
        [orderMeta.shipping_company_id],
      );
      if (company) {
        shippingOwnerId = company.owner_id;
        companyName = company.name;
      }
    }

    if (shippingOwnerId) {
      await processShippingTransaction(
        shippingOwnerId,
        globalShippingCost,
        companyName,
      );
    }
  }
};
// ===================================================================================
//  CONTROLLER
// ===================================================================================

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

    // 1. التحقق من الصلاحية: هل هذا الطلب يخص المورد؟
    const [authItems] = await connection.query(
      `SELECT oi.id 
             FROM order_items oi
             JOIN product_variants pv ON oi.product_variant_id = pv.id
             JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
             JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
             JOIN supplier_products sp ON spv.product_id = sp.id
             WHERE oi.order_id = ? AND sp.supplier_id = ?`,
      [orderId, supplierId],
    );

    if (authItems.length === 0) {
      await connection.rollback();
      return res.status(403).json({
        message: "لا تملك صلاحية تعديل هذا الطلب لأنه لا يحتوي على منتجاتك.",
      });
    }

    // جلب معلومات الطلب الحالية للتحقق من طريقة الدفع
    const [[order]] = await connection.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );

    // 2. تحديث حالة الطلب
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [
      status,
      orderId,
    ]);

    // 🔥 3. المعالجة المالية (نفس منطق التاجر بالضبط)
    // إذا كان الطلب COD، وأصبح مكتمل، ولم يتم تسجيل الأرباح من قبل -> سجلها الآن
    if (
      order.payment_method === "cod" &&
      status === "completed" &&
      !order.earnings_cleared
    ) {
      console.log(
        `💰 Supplier Completed COD Order #${orderId}. Registering Earnings...`,
      );

      // حساب وتسجيل الأرباح (معلقة Pending)
      await calculateAndRegisterEarnings(orderId, connection);

      // وضع علامة أن الأرباح سُجلت لمنع التكرار
      await connection.query(
        "UPDATE orders SET payment_status = 'paid', earnings_cleared = 1 WHERE id = ?",
        [orderId],
      );
    }

    // 4. إرسال إشعار للعميل
    const [[orderInfo]] = await connection.query(
      "SELECT customer_id FROM orders WHERE id = ?",
      [orderId],
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
        ],
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
 * @desc    Get supplier's wallet details and payout history (CORRECTED)
 * @route   GET /api/supplier/wallet
 * @access  Private/Supplier
 */
exports.getSupplierWallet = async (req, res) => {
  const supplierId = req.user.id;
  try {
    // ✅ تصحيح: حساب الرصيد الصافي (الأرباح المكتملة - السحوبات)
    // الأرباح المعلقة تظل كما هي للعرض فقط
    const query = `
            SELECT
                (
                    (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'cleared' AND type = 'earning') 
                    - 
                    (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND type = 'payout')
                ) AS balance,
                
                (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'pending_clearance') AS pending_clearance
            FROM DUAL;
        `;
    // نمرر supplierId ثلاث مرات للمعاملات الثلاث
    const [[wallet]] = await pool.query(query, [
      supplierId,
      supplierId,
      supplierId,
    ]);

    res.json({
      balance: parseFloat(wallet.balance || 0).toFixed(2),
      pending_clearance: parseFloat(wallet.pending_clearance || 0).toFixed(2),
    });
  } catch (error) {
    console.error("Error fetching supplier wallet data:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Request a payout from the supplier wallet (CORRECTED & SYNCED)
 * @route   POST /api/supplier/payout-request
 * @access  Private/Supplier
 */
exports.requestPayout = asyncHandler(async (req, res) => {
  const supplierId = req.user.id;
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. ✅ حساب الرصيد الفعلي المتاح للسحب من جدول المعاملات (نفس منطق العرض)
    // المعادلة: (مجموع الأرباح المكتملة) - (مجموع عمليات السحب السابقة)
    const [[balanceResult]] = await connection.query(
      `
            SELECT 
                (
                    (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'cleared' AND type = 'earning') 
                    - 
                    (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND type = 'payout')
                ) as current_balance
        `,
      [supplierId, supplierId],
    );

    const currentBalance = parseFloat(balanceResult.current_balance || 0);

    console.log(
      `[Payout] User: ${supplierId}, Requested: ${amount}, Available: ${currentBalance}`,
    );

    if (amount > currentBalance) {
      await connection.rollback();
      return res.status(400).json({
        message: "المبلغ المطلوب أكبر من رصيدك المتاح.",
        debug_info: `Available: ${currentBalance}, Requested: ${amount}`,
      });
    }

    // 2. ✅ تسجيل طلب السحب في جدول طلبات السحب (للمسؤول)
    const [payoutResult] = await connection.query(
      "INSERT INTO supplier_payout_requests (supplier_id, amount, status) VALUES (?, ?, 'pending')",
      [supplierId, amount],
    );

    // 3. ✅ تسجيل عملية "خصم" في جدول المعاملات فوراً لتقليل الرصيد
    // هذا يضمن أن المستخدم لا يستطيع سحب نفس المبلغ مرتين
    await connection.query(
      `INSERT INTO wallet_transactions 
            (user_id, amount, type, status, description, related_entity_type, related_entity_id, created_at) 
            VALUES (?, ?, 'payout', 'pending', ?, 'payout_request', ?, NOW())`,
      [
        supplierId,
        amount, // يمكن تسجيلها كموجب ونطرحها في الاستعلام، أو سالب ونجمعها. الكود أعلاه يطرح الـ payout
        `طلب سحب أرباح رقم #${payoutResult.insertId}`,
        payoutResult.insertId,
      ],
    );

    // ملاحظة: قمنا بإلغاء التحديث في supplier_wallets لأنه غير مستخدم في منطق العرض المحدث

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
    [supplierId],
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
    [supplierId, name, shipping_cost],
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
    [name, shipping_cost, id, supplierId],
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
    [id, supplierId],
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
      [req.user.id],
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
      ],
    );
    res.status(200).json({ message: "تم تحديث الإعدادات بنجاح!" });
  } catch (error) {
    console.error("Error updating store settings:", error);
    res.status(500).json({ message: "خطأ في تحديث الإعدادات." });
  }
});
