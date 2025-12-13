// backend/controllers/flashSaleController.js
const pool = require('../config/db');
const asyncHandler = require('express-async-handler');

// @desc    Get active flash sale
// @route   GET /api/flash-sale/active
// @access  Public
exports.getActiveFlashSale = asyncHandler(async (req, res) => {
  const now = new Date();
  
  // جلب العرض النشط حالياً
  const [sales] = await pool.query(
    `SELECT * FROM flash_sales 
     WHERE is_active = 1 AND start_time <= ? AND end_time > ? 
     ORDER BY end_time ASC LIMIT 1`,
    [now, now]
  );

  if (sales.length === 0) {
    return res.json(null); // لا يوجد عرض نشط
  }

  const sale = sales[0];

  // جلب المنتجات المرتبطة بالعرض
  const [products] = await pool.query(
    `SELECT 
        fsp.id as flash_item_id,
        fsp.discount_percentage,
        fsp.sold_quantity as sold,
        fsp.total_quantity as total,
        p.id, p.name, p.merchant_id,
        (SELECT id FROM product_variants WHERE product_id = p.id ORDER BY price ASC LIMIT 1) as default_variant_id,
        (SELECT price FROM product_variants WHERE product_id = p.id ORDER BY price ASC LIMIT 1) as originalPrice,
        (SELECT images FROM product_variants WHERE product_id = p.id ORDER BY price ASC LIMIT 1) as images_json
     FROM flash_sale_products fsp
     JOIN products p ON fsp.product_id = p.id
     WHERE fsp.flash_sale_id = ? 
       AND fsp.status = 'accepted' -- ✅ هذا الشرط سيمنع ظهور المنتجات غير الموافق عليها
       AND fsp.sold_quantity < fsp.total_quantity`,
    [sale.id]
  );

  // تنسيق البيانات
  const formattedProducts = products.map(p => {
    let image = '/placeholder.png';
    try {
        const images = JSON.parse(p.images_json || '[]');
        if (images.length > 0) image = images[0];
    } catch (e) {}

    const originalPrice = Number(p.originalPrice);
    const discountPrice = originalPrice - (originalPrice * (p.discount_percentage / 100));

    return {
        id: p.id,
        variant_id: p.default_variant_id, // ✅ إرسال رقم المتغير الحقيقي
        merchant_id: p.merchant_id,
        name: p.name,
        originalPrice,
        discountPrice: Math.round(discountPrice), // أو toFixed(2)
        sold: p.sold,
        total: p.total,
        image,
        alt: p.name
    };
  });

  // حساب الوقت المتبقي
  const endTime = new Date(sale.end_time);
  const diffMs = endTime - now;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

  res.json({
    id: sale.id,
    title: sale.title,
    endTime: sale.end_time,
    countdown: { hours, minutes, seconds },
    products: formattedProducts
  });
});

// @desc    Create new flash sale (Admin)
// @route   POST /api/admin/flash-sale
// @access  Private/Admin
exports.createFlashSale = asyncHandler(async (req, res) => {
    const { title, start_time, end_time, items } = req.body; 
    // items should be: [{ productId, variantId, merchantId, originalPrice, discount, totalQty }]

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. إنشاء الحملة
        const [saleResult] = await connection.query(
            "INSERT INTO flash_sales (title, start_time, end_time) VALUES (?, ?, ?)",
            [title, start_time, end_time]
        );
        const saleId = saleResult.insertId;

        // 2. إرسال الدعوات للمنتجات (Variants)
        for (const item of items) {
            const flashPrice = item.originalPrice - (item.originalPrice * (item.discount / 100));
            
            await connection.query(
                `INSERT INTO flash_sale_products 
                (flash_sale_id, product_id, variant_id, merchant_id, discount_percentage, flash_price, total_quantity, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [saleId, item.productId, item.variantId, item.merchantId, item.discount, flashPrice, item.totalQty]
            );

            // ✨ (اختياري) إرسال إشعار للتاجر هنا
             await connection.query(
                "INSERT INTO notifications (user_id, type, message, link) VALUES (?, 'CAMPAIGN_INVITE', ?, ?)",
                [item.merchantId, `دعوة للانضمام لحملة: ${title}`, '/dashboard/campaigns']
            );
        }

        await connection.commit();
        res.status(201).json({ message: "تم إنشاء الحملة وإرسال الدعوات للتجار." });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
});

// ب. دالة للتاجر للموافقة/الرفض
exports.respondToCampaign = asyncHandler(async (req, res) => {
    const { id } = req.params; // flash_sale_product id
    const { status } = req.body; // 'accepted' or 'rejected'
    const merchantId = req.user.id;

    if (!['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
    }

    const [result] = await pool.query(
        "UPDATE flash_sale_products SET status = ? WHERE id = ? AND merchant_id = ?",
        [status, id, merchantId]
    );

    if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Item not found or unauthorized" });
    }

    res.json({ message: `Campaign invitation ${status}` });
});

// ج. دالة للتاجر لرؤية الدعوات
exports.getMerchantCampaigns = asyncHandler(async (req, res) => {
    const merchantId = req.user.id;
    
    const [campaigns] = await pool.query(`
        SELECT 
            fsp.id, fsp.status, fsp.discount_percentage, fsp.flash_price, fsp.total_quantity,
            fs.title as campaign_title, fs.start_time, fs.end_time,
            p.name as product_name, 
            v.color, v.price as original_price
        FROM flash_sale_products fsp
        JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
        JOIN products p ON fsp.product_id = p.id
        JOIN product_variants v ON fsp.variant_id = v.id
        WHERE fsp.merchant_id = ?
        ORDER BY fs.start_time DESC
    `, [merchantId]);

    res.json(campaigns);
});

// @desc    Get all flash sales (Admin)
// @route   GET /api/admin/flash-sales
// @access  Private/Admin
exports.getAllFlashSales = asyncHandler(async (req, res) => {
  const [sales] = await pool.query(`
    SELECT 
      id, 
      title, 
      start_time, 
      end_time,
      is_active
    FROM flash_sales
    ORDER BY start_time DESC
  `);

  // Optionally, get product counts for each sale
  const salesWithCounts = await Promise.all(
    sales.map(async (sale) => {
      const [productCountResult] = await pool.query(
        'SELECT COUNT(*) as count FROM flash_sale_products WHERE flash_sale_id = ?',
        [sale.id]
      );
      return {
        ...sale,
        product_count: productCountResult[0].count
      };
    })
  );

  res.json(salesWithCounts);
});