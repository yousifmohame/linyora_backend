// backend/controllers/flashSaleController.js
const pool = require('../config/db');
const asyncHandler = require('express-async-handler');
const sendEmail = require('../utils/emailService'); // ✅ استيراد خدمة الإيميل


// @desc    Get products NOT in any conflicting flash sale
// @route   GET /api/admin/flash-sale/available-products
// @access  Private/Admin
exports.getAvailableProductsForFlashSale = asyncHandler(async (req, res) => {
    // لا نحتاج لاستقبال start_time أو end_time هنا بعد الآن

    const query = `
        SELECT 
            p.id, p.name, p.merchant_id, u.store_name as merchantName,
            v.id as variant_id, v.color, v.price, v.stock_quantity, v.images
        FROM products p
        JOIN users u ON p.merchant_id = u.id
        JOIN product_variants v ON p.id = v.product_id
        WHERE p.status = 'active'
        AND v.stock_quantity > 0
        AND v.id NOT IN (
            SELECT fsp.variant_id 
            FROM flash_sale_products fsp
            JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
            WHERE fs.is_active = 1
            AND fsp.status != 'rejected'
            -- ✅ الشرط البسيط: المنتج محجوز إذا كانت الحملة نشطة ولم ينتهِ وقتها بعد
            -- هذا يمنع حجز المنتج في حملتين مختلفتين حتى لو لم يكن بينهما تداخل زمني
            AND fs.end_time > NOW() 
        )
    `;

    const [rows] = await pool.query(query);

    // تجميع النتائج
    const productsMap = new Map();

    rows.forEach(row => {
        if (!productsMap.has(row.id)) {
            productsMap.set(row.id, {
                id: row.id,
                name: row.name,
                merchant_id: row.merchant_id,
                merchantName: row.merchantName,
                variants: []
            });
        }
        
        let images = [];
        try { images = JSON.parse(row.images || '[]'); } catch (e) {}

        productsMap.get(row.id).variants.push({
            id: row.variant_id,
            color: row.color,
            price: row.price,
            stock_quantity: row.stock_quantity,
            images: images
        });
    });

    res.json(Array.from(productsMap.values()));
});
// @desc    Get active flash sale
// @route   GET /api/flash-sale/active
// @access  Public
exports.getActiveFlashSale = asyncHandler(async (req, res) => {
  const now = new Date();
  
  // 1. إزالة LIMIT 1 لجلب كل العروض النشطة
  const [sales] = await pool.query(
    `SELECT * FROM flash_sales 
      WHERE is_active = 1 AND start_time <= ? AND end_time > ? 
      ORDER BY end_time ASC`, 
    [now, now]
  );

  if (sales.length === 0) {
    return res.json([]); 
  }

  // 2. استخدام Promise.all لمعالجة كل عرض وجلب منتجاته
  const campaigns = await Promise.all(sales.map(async (sale) => {
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
           AND fsp.status = 'accepted'
           AND fsp.sold_quantity < fsp.total_quantity`,
        [sale.id]
      );

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
            variant_id: p.default_variant_id,
            merchant_id: p.merchant_id,
            name: p.name,
            originalPrice,
            discountPrice: Math.round(discountPrice),
            sold: p.sold,
            total: p.total,
            image,
            alt: p.name
        };
      });

      return {
        id: sale.id,
        title: sale.title,
        endTime: sale.end_time,
        products: formattedProducts
      };
  }));

  res.json(campaigns);
});

// @desc    Create new flash sale (Admin)
// @route   POST /api/admin/flash-sale
// @access  Private/Admin
exports.createFlashSale = asyncHandler(async (req, res) => {
    const { title, start_time, end_time, items } = req.body; 
    // items example: [{ productId, variantId, merchantId, originalPrice, discount, totalQty, name }]

    if (!items || items.length === 0) {
        res.status(400);
        throw new Error("يجب اختيار منتجات للحملة.");
    }

    const formattedStartTime = new Date(start_time).toISOString().slice(0, 19).replace('T', ' ');
    const formattedEndTime = new Date(end_time).toISOString().slice(0, 19).replace('T', ' ');

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. ✅ التحقق من التضارب: هل المنتجات مشاركة في حملات أخرى في نفس الوقت؟
        const variantIds = items.map(i => i.variantId);
        
        // استعلام يفحص التداخل الزمني للمنتجات المختارة
        const [conflicts] = await connection.query(`
            SELECT p.name, fsp.variant_id
            FROM flash_sale_products fsp
            JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
            JOIN products p ON fsp.product_id = p.id
            WHERE fs.is_active = 1
            AND fs.end_time > NOW()
            AND fsp.status != 'rejected'
            AND (
                (fs.start_time < ? AND fs.end_time > ?) -- شرط التداخل الزمني
            )
            AND fsp.variant_id IN (?)
        `, [end_time, start_time, variantIds]);

        if (conflicts.length > 0) {
            const conflictNames = conflicts.map(c => c.name).join(', ');
            res.status(400);
            throw new Error(`لا يمكن إنشاء الحملة. المنتجات التالية مرتبطة بحملات أخرى في نفس التوقيت: ${conflictNames}`);
        }

        // 2. إنشاء الحملة
        const [saleResult] = await connection.query(
            "INSERT INTO flash_sales (title, start_time, end_time) VALUES (?, ?, ?)",
            [title, formattedStartTime, formattedEndTime]
        );
        const saleId = saleResult.insertId;

        // تجهيز قائمة لإرسال الإيميلات (تجميع المنتجات لكل تاجر)
        const merchantsToNotify = {};

        // 3. إدخال المنتجات
        for (const item of items) {
            const flashPrice = item.originalPrice - (item.originalPrice * (item.discount / 100));
            
            await connection.query(
                `INSERT INTO flash_sale_products 
                (flash_sale_id, product_id, variant_id, merchant_id, discount_percentage, flash_price, total_quantity, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [saleId, item.productId, item.variantId, item.merchantId, item.discount, flashPrice, item.totalQty]
            );

            // تجميع البيانات للإشعار
            if (!merchantsToNotify[item.merchantId]) {
                merchantsToNotify[item.merchantId] = {
                    items: []
                };
            }
            merchantsToNotify[item.merchantId].items.push(item.name);

            // إرسال إشعار داخل النظام
             await connection.query(
                "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, 'CAMPAIGN_INVITE', 'zap', ?, ?)",
                [item.merchantId, `دعوة للانضمام لحملة: ${title}`, '/dashboard/campaigns']
            );
        }

        await connection.commit();

        // 4. ✅ إرسال الإيميلات (خارج الـ Transaction لتجنب البطء)
        // نجلب إيميلات التجار
        const merchantIds = Object.keys(merchantsToNotify);
        if (merchantIds.length > 0) {
            const [merchantsData] = await pool.query(
                "SELECT id, email, name FROM users WHERE id IN (?)",
                [merchantIds]
            );

            // إرسال الإيميلات بشكل متوازي
            Promise.allSettled(merchantsData.map(async (merchant) => {
                const productsList = merchantsToNotify[merchant.id].items.map(p => `<li>${p}</li>`).join('');
                
                await sendEmail({
                    to: merchant.email,
                    subject: ` دعوة خاصة: انضم لحملة "${title}" على لينيورا! 🚀`,
                    html: `
                        <div style="font-family: Arial, sans-serif; dir: rtl; text-align: right;">
                            <h2>مرحباً ${merchant.name}،</h2>
                            <p>تم اختيار منتجاتك للمشاركة في حملة التخفيضات الجديدة <strong>"${title}"</strong>.</p>
                            <p><strong>فترة الحملة:</strong> من ${new Date(start_time).toLocaleDateString()} إلى ${new Date(end_time).toLocaleDateString()}</p>
                            <p>المنتجات المرشحة:</p>
                            <ul>${productsList}</ul>
                            <p>يرجى الدخول إلى لوحة التحكم للموافقة على الخصومات المقترحة والبدء في زيادة مبيعاتك.</p>
                            <a href="${process.env.FRONTEND_URL}/dashboard/campaigns" style="background: #e11d48; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">عرض الدعوة</a>
                        </div>
                    `
                });
            })).catch(console.error);
        }

        res.status(201).json({ message: "تم إنشاء الحملة، التحقق من التضارب، وإرسال الدعوات بنجاح." });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
});

// @desc    Update existing flash sale (Admin)
// @route   PUT /api/admin/flash-sale/:id
// @access  Private/Admin
exports.updateFlashSale = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, start_time, end_time, is_active } = req.body;

    // 1. التحقق من وجود الحملة
    const [sale] = await pool.query("SELECT * FROM flash_sales WHERE id = ?", [id]);
    if (sale.length === 0) {
        res.status(404);
        throw new Error("الحملة غير موجودة.");
    }

    // 2. تحديث البيانات الأساسية
    await pool.query(
        `UPDATE flash_sales 
         SET title = COALESCE(?, title), 
             start_time = COALESCE(?, start_time), 
             end_time = COALESCE(?, end_time),
             is_active = COALESCE(?, is_active)
         WHERE id = ?`,
        [title, start_time, end_time, is_active, id]
    );

    res.json({ message: "تم تحديث بيانات الحملة بنجاح." });
});

// @desc    Delete flash sale (Admin)
// @route   DELETE /api/admin/flash-sale/:id
// @access  Private/Admin
exports.deleteFlashSale = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const connection = await pool.getConnection();
    try {
        // 1. التحقق من وجود الحملة
        const [sale] = await connection.query("SELECT * FROM flash_sales WHERE id = ?", [id]);
        if (sale.length === 0) {
            res.status(404);
            throw new Error("الحملة غير موجودة.");
        }

        // 2. حذف المنتجات المرتبطة أولاً (على الرغم من أن CASCADE قد يتكفل بذلك، لكن للأمان)
        await connection.query("DELETE FROM flash_sale_products WHERE flash_sale_id = ?", [id]);

        // 3. حذف الحملة نفسها
        await connection.query("DELETE FROM flash_sales WHERE id = ?", [id]);

        res.json({ message: "تم حذف الحملة وجميع المنتجات المرتبطة بها." });
    } catch (error) {
        throw error;
    } finally {
        connection.release();
    }
});

// @desc    Merchant responds to campaign
// @route   PUT /api/flash-sale/merchant/:id/respond
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

// @desc    Get merchant invitations
// @route   GET /api/flash-sale/merchant
exports.getMerchantCampaigns = asyncHandler(async (req, res) => {
    const merchantId = req.user.id;
    
    // جلب المنتجات + الحملة + الصورة
    const [campaigns] = await pool.query(`
        SELECT 
            fsp.id, fsp.status, fsp.discount_percentage, fsp.flash_price, fsp.total_quantity,
            fsp.sold_quantity,
            fs.title as campaign_title, fs.start_time, fs.end_time,
            p.name as product_name, 
            v.color as variant_color, v.price as original_price, v.images
        FROM flash_sale_products fsp
        JOIN flash_sales fs ON fsp.flash_sale_id = fs.id
        JOIN products p ON fsp.product_id = p.id
        JOIN product_variants v ON fsp.variant_id = v.id
        WHERE fsp.merchant_id = ?
        ORDER BY fs.start_time DESC
    `, [merchantId]);

    // معالجة الصور
    const formattedCampaigns = campaigns.map(camp => {
        let image = '/placeholder.png'; 
        try {
            const imagesArray = typeof camp.images === 'string' ? JSON.parse(camp.images) : camp.images;
            if (Array.isArray(imagesArray) && imagesArray.length > 0) {
                image = imagesArray[0];
            }
        } catch (error) {
            console.error("Image parse error", error);
        }

        return {
            ...camp,
            image: image,
            images: undefined 
        };
    });

    res.json(formattedCampaigns);
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