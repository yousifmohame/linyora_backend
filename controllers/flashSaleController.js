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
        p.id, p.name, 
        (SELECT MIN(price) FROM product_variants WHERE product_id = p.id) as originalPrice,
        (SELECT images FROM product_variants WHERE product_id = p.id LIMIT 1) as images_json
     FROM flash_sale_products fsp
     JOIN products p ON fsp.product_id = p.id
     WHERE fsp.flash_sale_id = ?`,
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
    const { title, start_time, end_time, products } = req.body; // products = [{productId, discount, totalQty}]

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [result] = await connection.query(
            "INSERT INTO flash_sales (title, start_time, end_time) VALUES (?, ?, ?)",
            [title, start_time, end_time]
        );
        const saleId = result.insertId;

        for (const prod of products) {
            await connection.query(
                "INSERT INTO flash_sale_products (flash_sale_id, product_id, discount_percentage, total_quantity) VALUES (?, ?, ?, ?)",
                [saleId, prod.productId, prod.discount, prod.totalQty]
            );
        }

        await connection.commit();
        res.status(201).json({ message: "Flash sale created successfully" });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
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