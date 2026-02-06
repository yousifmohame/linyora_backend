// controllers/reelsController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

const getProductDetailsQuery = (
  extraJoin = "",
  whereClause = "",
  groupBy = ""
) => `
SELECT 
  p.id, 
  p.name, 
  p.description, 
  p.brand,
  p.merchant_id,
  p.created_at,
  u.store_name as merchantName,
  v_data.price, 
  v_data.compare_at_price, 
  v_data.images,
  COALESCE(r_data.avg_rating, 0) as rating,
  COALESCE(r_data.review_count, 0) as reviewCount
FROM products p
JOIN users u ON p.merchant_id = u.id
INNER JOIN (
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
) v_data ON p.id = v_data.product_id
LEFT JOIN (
    SELECT 
      product_id, 
      AVG(rating) as avg_rating, 
      COUNT(id) as review_count 
    FROM product_reviews 
    GROUP BY product_id
) r_data ON p.id = r_data.product_id
${extraJoin}
WHERE p.status = 'active' ${whereClause}
${groupBy}
`;
// @desc    جلب الفيديوهات للصفحة الرئيسية
// @access  Public
exports.getReelsForHomepage = async (req, res) => {
  try {
    // --- الخطوة 1: جلب الفيديوهات الأساسية ومعلومات المستخدم وعدد الإعجابات ---
    // (أزلنا الاستعلام الفرعي الخاص بـ JSON_ARRAYAGG)
    const queryReels = `
            SELECT 
                r.id, r.video_url, r.thumbnail_url, r.caption, r.views_count,
                u.id as userId, u.name as userName, u.profile_picture_url as userAvatar,
                (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count,
                (SELECT COUNT(*) FROM reel_comments rc WHERE rc.reel_id = r.id) as comments_count
            FROM reels r
            JOIN users u ON r.user_id = u.id
            WHERE r.is_active = 1
            ORDER BY r.created_at DESC
            LIMIT 10;
        `;

    const [reels] = await pool.query(queryReels);

    if (reels.length === 0) {
      // إذا لم تكن هناك فيديوهات، أرجع مصفوفة فارغة
      return res.status(200).json([]);
    }
    // استخراج معرفات الفيديوهات التي جلبناها
    const reelIds = reels.map((reel) => reel.id);
    const queryTags = `
            SELECT
                rpt.reel_id,
                p.id,
                p.name,
                (SELECT
                    JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]'))
                 FROM product_variants pv
                 WHERE pv.product_id = p.id
                 LIMIT 1
                ) as image_url
            FROM reel_product_tags rpt
            JOIN products p ON rpt.product_id = p.id
            WHERE rpt.reel_id IN (?);
        `;
    const [taggedProducts] = await pool.query(queryTags, [reelIds]);

    // --- الخطوة 3: تجميع المنتجات مع الفيديوهات في كود Node.js ---

    // إنشاء خريطة (Map) لتسهيل عملية التجميع
    const productMap = new Map();
    for (const product of taggedProducts) {
      const reelId = product.reel_id;
      if (!productMap.has(reelId)) {
        productMap.set(reelId, []);
      }
      // إزالة reel_id من كائن المنتج قبل إضافته للمصفوفة
      const { reel_id, ...productDetails } = product;
      productMap.get(reelId).push(productDetails);
    }

    // إضافة مصفوفة المنتجات (tags) لكل فيديو
    const formattedReels = reels.map((reel) => ({
      ...reel,
      tagged_products: productMap.get(reel.id) || [], // إضافة المنتجات (أو مصفوفة فارغة)
    }));

    res.status(200).json(formattedReels);
  } catch (error) {
    console.error("Error fetching reels:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadReel = async (req, res) => {
  const userId = req.user.id;
  const videoUrl = req.file?.path; // يأتي من (uploadMiddleware)
  const { caption, tagged_products } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ message: "Video file is required" });
  }

  // --- (!!!) بداية الإضافة: إنشاء رابط الصورة المصغرة ---
  // Cloudinary يقوم بإنشاء صورة .jpg تلقائياً بمجرد تغيير الامتداد
  const thumbnailUrl = videoUrl.replace(/\.(mp4|mov|avi|wmv|flv)$/i, '.jpg');
  // --- (!!!) نهاية الإضافة ---


  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // --- (!!!) تعديل: إضافة thumbnailUrl إلى الاستعلام ---
    const reelQuery =
      "INSERT INTO reels (user_id, video_url, thumbnail_url, caption) VALUES (?, ?, ?, ?)";
    const [reelResult] = await connection.query(reelQuery, [
      userId,
      videoUrl,
      thumbnailUrl, // <-- تمرير الرابط الجديد هنا
      caption || null,
    ]);
    // --- (!!!) نهاية التعديل ---

    const newReelId = reelResult.insertId;

    if (tagged_products && tagged_products !== "[]") {
      const productIds = JSON.parse(tagged_products);

      if (Array.isArray(productIds) && productIds.length > 0) {
        const tagsData = productIds.map((productId) => [newReelId, productId]);
        const tagsQuery =
          "INSERT INTO reel_product_tags (reel_id, product_id) VALUES ?";
        await connection.query(tagsQuery, [tagsData]);
      }
    }

    await connection.commit();
    res
      .status(201)
      .json({ message: "Reel uploaded successfully", reelId: newReelId });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error("Error during reel upload:", error); // <-- إضافة console.error
    res.status(500).json({ message: "Server error during reel upload" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

exports.likeReel = async (req, res) => {
  const reelId = req.params.id;
  const userId = req.user.id; // يأتي من middleware 'protect'

  try {
    // التأكد أولاً أن الفيديو موجود
    const [reelExists] = await pool.query("SELECT id FROM reels WHERE id = ?", [
      reelId,
    ]);
    if (reelExists.length === 0) {
      console.log(`--- LikeReel Error: Reel ${reelId} not found ---`);
      return res.status(404).json({ message: "Reel not found" });
    }

    // محاولة إضافة الإعجاب (سيفشل إذا كان المستخدم قد أعجب به بالفعل بسبب القيد UNIQUE)
    const query = "INSERT INTO reel_likes (reel_id, user_id) VALUES (?, ?)";
    await pool.query(query, [reelId, userId]);

    res.status(200).json({ message: "Reel liked successfully" });
  } catch (error) {
    // إذا كان الخطأ بسبب وجود إعجاب مسبق (ER_DUP_ENTRY) - فهذا ليس خطأ حقيقي
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(200).json({ message: "Reel already liked" });
    }
    res.status(500).json({ message: "Server error while liking reel" });
  }
};

exports.unlikeReel = async (req, res) => {
  const reelId = req.params.id;
  const userId = req.user.id; // يأتي من middleware 'protect'

  try {
    // التأكد أولاً أن الفيديو موجود
    const [reelExists] = await pool.query("SELECT id FROM reels WHERE id = ?", [
      reelId,
    ]);
    if (reelExists.length === 0) {
      return res.status(404).json({ message: "Reel not found" });
    }

    // محاولة حذف الإعجاب
    const query = "DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?";
    const [result] = await pool.query(query, [reelId, userId]);

    if (result.affectedRows === 0) {
      return res.status(200).json({ message: "Reel was not liked previously" });
    }

    res.status(200).json({ message: "Reel unliked successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error while unliking reel" });
  }
};

exports.commentOnReel = async (req, res) => {
  const reelId = req.params.id;
  const userId = req.user.id;
  const { comment } = req.body;

  if (!comment || comment.trim() === "") {
    return res.status(400).json({ message: "Comment text cannot be empty" });
  }

  try {
    // التأكد أولاً أن الفيديو موجود
    const [reelExists] = await pool.query("SELECT id FROM reels WHERE id = ?", [
      reelId,
    ]);
    if (reelExists.length === 0) {
      return res.status(404).json({ message: "Reel not found" });
    }

    // إضافة التعليق إلى قاعدة البيانات
    const query =
      "INSERT INTO reel_comments (reel_id, user_id, comment) VALUES (?, ?, ?)";
    const [result] = await pool.query(query, [reelId, userId, comment]);

    // جلب التعليق الجديد مع معلومات المستخدم لعرضه فوراً في الواجهة الأمامية
    const newCommentId = result.insertId;
    const [newCommentData] = await pool.query(
      `
            SELECT rc.id, rc.comment, rc.created_at, u.id as userId, u.name as userName, u.profile_picture_url as userAvatar
            FROM reel_comments rc
            JOIN users u ON rc.user_id = u.id
            WHERE rc.id = ?
        `,
      [newCommentId]
    );
    res.status(201).json(newCommentData[0]); // إرجاع بيانات التعليق الجديد
  } catch (error) {
    res.status(500).json({ message: "Server error while adding comment" });
  }
};

// @desc    زيادة عدد المشاهدات للفيديو
// @route   POST /api/reels/:id/view
// @access  Public
exports.incrementViewCount = asyncHandler(async (req, res) => {
  const reelId = req.params.id;

  const [result] = await pool.query(
    "UPDATE reels SET views_count = views_count + 1 WHERE id = ?",
    [reelId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "Reel not found" });
  }

  res.status(200).json({ message: "View counted successfully" });
});

exports.getReelComments = async (req, res) => {
  const reelId = req.params.id;
  // يمكن إضافة ترقيم الصفحات (Pagination) لاحقاً
  const limit = parseInt(req.query.limit) || 20; // جلب آخر 20 تعليق افتراضياً
  const offset = parseInt(req.query.offset) || 0;

  try {
    // التأكد أولاً أن الفيديو موجود (اختياري لكن جيد)
    const [reelExists] = await pool.query("SELECT id FROM reels WHERE id = ?", [
      reelId,
    ]);
    if (reelExists.length === 0) {
      return res.status(404).json({ message: "Reel not found" });
    }

    // جلب التعليقات مع معلومات المستخدمين، مرتبة بالأحدث أولاً
    const query = `
            SELECT rc.id, rc.comment, rc.created_at, u.id as userId, u.name as userName, u.profile_picture_url as userAvatar
            FROM reel_comments rc
            JOIN users u ON rc.user_id = u.id
            WHERE rc.reel_id = ?
            ORDER BY rc.created_at DESC
            LIMIT ?
            OFFSET ?;
        `;
    const [comments] = await pool.query(query, [reelId, limit, offset]);

    res.status(200).json(comments);
  } catch (error) {
    console.error("--- GetReelComments Error: ---", error);
    res.status(500).json({ message: "Server error while fetching comments" });
  }
};

exports.getReelsLikeStatus = async (req, res) => {
  const userId = req.user.id; // From 'protect' middleware
  const { reelIds } = req.body; // Expecting an array like [1, 2, 3]

  // Validate input
  if (!Array.isArray(reelIds) || reelIds.length === 0) {
    return res.status(200).json({}); // Return empty object if no IDs provided
  }

  // Ensure IDs are numbers to prevent SQL injection
  const validReelIds = reelIds.filter(
    (id) => typeof id === "number" && Number.isInteger(id) && id > 0
  );
  if (validReelIds.length === 0) {
    return res.status(200).json({});
  }

  try {
    // Query the reel_likes table to find entries matching the user and the provided reel IDs
    const query = `
            SELECT reel_id 
            FROM reel_likes 
            WHERE user_id = ? AND reel_id IN (?)
        `;
    const [likes] = await pool.query(query, [userId, validReelIds]);

    // Create a Set of liked reel IDs for quick lookup
    const likedIdsSet = new Set(likes.map((like) => like.reel_id));

    // Construct the response object { reelId: boolean }
    const likeStatusResult = {};
    validReelIds.forEach((reelId) => {
      likeStatusResult[reelId] = likedIdsSet.has(reelId);
    });

    res.status(200).json(likeStatusResult);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error while fetching like status" });
  }
};

exports.getReelById = async (req, res) => {
  const reelId = req.params.id;
  // قد نحتاج لمعرف المستخدم الحالي لمعرفة هل أعجب بالفيديو أم لا
  const userId = req.user?.id; // req.user قد يكون موجوداً إذا كان المستخدم مسجلاً (من protect اختياري)
  try {
    // --- جلب بيانات الفيديو الأساسية ومعلومات المستخدم والإعجابات والتعليقات ---
    const queryReel = `
            SELECT 
                r.id, r.video_url, r.thumbnail_url, r.caption, r.views_count, r.created_at,
                u.id as userId, u.name as userName, u.profile_picture_url as userAvatar,
                (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count,
                (SELECT COUNT(*) FROM reel_comments rc WHERE rc.reel_id = r.id) as comments_count,
                ${
                  userId
                    ? "(SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id AND rl.user_id = ?) > 0"
                    : "FALSE"
                } as isLikedByCurrentUser -- التحقق من إعجاب المستخدم الحالي
            FROM reels r
            JOIN users u ON r.user_id = u.id
            WHERE r.id = ? AND r.is_active = 1; 
        `;
    // نضيف userId فقط إذا كان موجوداً
    const queryParams = userId ? [userId, reelId] : [reelId];
    const [reelResult] = await pool.query(queryReel, queryParams);

    if (reelResult.length === 0) {
      return res.status(404).json({ message: "Reel not found" });
    }

    const reel = reelResult[0];
    // تحويل isLikedByCurrentUser إلى boolean
    reel.isLikedByCurrentUser = Boolean(reel.isLikedByCurrentUser);

    // --- جلب المنتجات المرتبطة (Tags) ---
    const queryTags = `
            SELECT 
                p.id, p.name, 
                (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]'))
                 FROM product_variants pv
                 WHERE pv.product_id = p.id LIMIT 1
                ) as image_url
            FROM reel_product_tags rpt 
            JOIN products p ON rpt.product_id = p.id 
            WHERE rpt.reel_id = ?;
        `;
    const [taggedProducts] = await pool.query(queryTags, [reelId]);

    // --- جلب آخر N تعليقات (يمكن جلبها بشكل منفصل عند الحاجة) ---
    // (يمكننا إعادة استخدام دالة getReelComments هنا أو جلبها في طلب منفصل من الفرونت إند)
    // حالياً، سنضيفها هنا كمثال بسيط (آخر 5 تعليقات)
    const queryComments = `
            SELECT rc.id, rc.comment, rc.created_at, u.id as userId, u.name as userName, u.profile_picture_url as userAvatar
            FROM reel_comments rc
            JOIN users u ON rc.user_id = u.id
            WHERE rc.reel_id = ?
            ORDER BY rc.created_at DESC
            LIMIT 5; 
        `;
    const [comments] = await pool.query(queryComments, [reelId]);

    // --- تجميع البيانات النهائية ---
    const responseData = {
      ...reel,
      tagged_products: taggedProducts || [],
      comments: comments || [], // إضافة التعليقات
    };
    res.status(200).json(responseData);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Server error while fetching reel details" });
  }
};

// @desc    Increment share count for a reel
// @route   POST /api/reels/:id/share
// @access  Public
exports.incrementShareCount = asyncHandler(async (req, res) => {
  const [result] = await pool.query(
    "UPDATE reels SET shares_count = shares_count + 1 WHERE id = ?",
    [req.params.id]
  );

  if (result.affectedRows === 0) {
    res.status(404);
    throw new Error("Reel not found");
  }

  // جلب العدد المحدث
  const [[reel]] = await pool.query(
    "SELECT shares_count FROM reels WHERE id = ?",
    [req.params.id]
  );

  res.status(200).json({ shares_count: reel.shares_count });
});

// @desc    جلب كل الفيديوهات مع Pagination (لصفحة Reels الرئيسية)
// @route   GET /api/v1/reels
// @access  Public
exports.getAllReels = asyncHandler(async (req, res) => {
  // --- ✨ 1. التعديل: اقرأ المتغيرات بدون قيمة افتراضية
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);
  const userId = req.user?.id; // req.user يأتي من optionalProtect

  try {
    // --- ✨ 2. التعديل: بناء مصفوفة المتغيرات ديناميكياً
    const queryParams = [];
    if (userId) {
      queryParams.push(userId, userId);
    }

    // --- ✨ 3. التعديل: بناء الاستعلام بدون LIMIT و OFFSET
    let queryReels = `
      SELECT 
        r.id, r.video_url, r.thumbnail_url, r.caption, r.views_count, r.created_at,
        r.shares_count,
        u.id as userId, u.name as userName, u.profile_picture_url as userAvatar,
        (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count,
        (SELECT COUNT(*) FROM reel_comments rc WHERE rc.reel_id = r.id) as comments_count,
        ${
          userId
            ? `(SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id AND rl.user_id = ?) > 0`
            : "FALSE"
        } as isLikedByMe,
        ${
          userId
            ? `(SELECT COUNT(*) FROM user_follows uf WHERE uf.follower_id = ? AND uf.following_id = u.id) > 0`
            : "FALSE"
        } as isFollowedByMe
      FROM reels r
      JOIN users u ON r.user_id = u.id
      WHERE r.is_active = 1
      ORDER BY r.created_at DESC
    `; // ❗️ تم حذف LIMIT ? OFFSET ? من هنا

    // --- ✨ 4. التعديل: أضف LIMIT و OFFSET فقط إذا تم توفيرها
    if (limit && page) {
      const offset = (page - 1) * limit;
      queryReels += ` LIMIT ? OFFSET ?`;
      queryParams.push(limit, offset);
    }
    
    queryReels += `;`; // أضف الفاصلة المنقوطة في النهاية

    // --- 5. تنفيذ الاستعلام بالمتغيرات الديناميكية
    const [reels] = await pool.query(queryReels, queryParams);

    if (reels.length === 0 && page === 1) {
      return res.status(200).json({ reels: [], hasMore: false });
    }

    // (باقي الكود الخاص بك سليم كما هو)
    
    // تحويل القيم إلى boolean
    reels.forEach((reel) => {
      reel.isLikedByMe = Boolean(reel.isLikedByMe);
      reel.isFollowedByMe = Boolean(reel.isFollowedByMe);
    });
    
    const reelIds = reels.map((reel) => reel.id);
    let taggedProducts = [];
    if (reelIds.length > 0) {
      const queryTags = `
        SELECT 
          rpt.reel_id, p.id, p.name, 
          (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]'))
          FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1
          ) as image_url
        FROM reel_product_tags rpt 
        JOIN products p ON rpt.product_id = p.id 
        WHERE rpt.reel_id IN (?);
      `;
      [taggedProducts] = await pool.query(queryTags, [reelIds]);
    }

    const productMap = new Map();
    for (const product of taggedProducts) {
      const reelId = product.reel_id;
      if (!productMap.has(reelId)) {
        productMap.set(reelId, []);
      }
      const { reel_id, ...productDetails } = product;
      productMap.get(reelId).push(productDetails);
    }

    const formattedReels = reels.map((reel) => ({
      ...reel,
      tagged_products: productMap.get(reel.id) || [],
    }));

    // --- ✨ 6. التعديل: حساب hasMore فقط إذا كان هناك limit
    let hasMore = false;
    if (limit) {
      hasMore = reels.length === limit;
    }
    
    res.status(200).json({ reels: formattedReels, hasMore: hasMore });
  } catch (error) {
    console.error("Error fetching reels:", error);
    res.status(500).json({ message: "Server error while fetching reels" });
  }
});

/**
 * @desc    Get all products tagged in a specific reel
 * @route   GET /api/reels/:id/products
 * @access  Public
 */
exports.getReelProducts = asyncHandler(async (req, res) => {
  const { id: reelId } = req.params;

  // الخطوة 1: جلب IDs المنتجات المرتبطة بالـ Reel
  const [productTags] = await pool.query(
    "SELECT product_id FROM reel_product_tags WHERE reel_id = ?",
    [reelId]
  );

  if (productTags.length === 0) {
    return res.status(200).json([]); // إرجاع مصفوفة فارغة إذا لم تكن هناك منتجات
  }

  const productIds = productTags.map((tag) => tag.product_id);

  // الخطوة 2: جلب بيانات المنتجات باستخدام الدالة المساعدة (التي تجلب السعر/الخصم/الصورة بشكل صحيح)
  const productsQuery = `
    ${getProductDetailsQuery(
      "", // No extra joins
      "AND p.id IN (?)", // Filter by our product IDs
      "GROUP BY p.id" // Group by product ID
    )}
  `;

  const [products] = await pool.query(productsQuery, [productIds]);

  // الخطوة 3: تحويل البيانات لتطابق تماماً ما يتوقعه المكون
  const formattedProducts = products.map((product) => {
    let imageUrl = null;
    try {
      // استخراج الصورة الأولى من مصفوفة الصور النصية
      const imagesArray = JSON.parse(product.images || "[]");
      if (imagesArray.length > 0) {
        imageUrl = imagesArray[0];
      }
    } catch (e) {
      // اتركه null إذا فشل التحليل
    }

    return {
      id: product.id,
      name: product.name,
      price: product.price, // ⭐️ السعر (الأرخص)
      discount_price: product.compare_at_price, // ⭐️ المكون يتوقع هذا الاسم
      image_url: imageUrl, // ⭐️ المكون يتوقع هذا الاسم
    };
  });

  res.status(200).json(formattedProducts);
});

exports.handleShare = asyncHandler(async (req, res) => {
  const [result] = await pool.query(
    "UPDATE reels SET shares_count = shares_count + 1 WHERE id = ?",
    [req.params.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "Reel not found" });
  }
  const [[reel]] = await pool.query(
    "SELECT shares_count FROM reels WHERE id = ?",
    [req.params.id]
  );
  res.status(200).json({ shares_count: reel.shares_count });
});


// (أضف هذا الكود في نهاية ملف controllers/reelsController.js)

/**
 * @desc    Get all reels for the currently logged-in user (model/influencer)
 * @route   GET /api/reels/my-reels
 * @access  Private (Protect)
 */
exports.getMyReels = asyncHandler(async (req, res) => {
  const userId = req.user.id; // (يأتي من 'protect' middleware)

  if (!userId) {
    return res.status(401).json({ message: 'User not authorized' });
  }

  try {
    // جلب كل الفيديوهات الخاصة بهذا المستخدم
    const query = `
      SELECT 
        r.id, 
        r.thumbnail_url, 
        r.caption, 
        r.views_count, 
        r.is_active,
        (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count
      FROM reels r
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
    `;
    
    const [reels] = await pool.query(query, [userId]);

    res.status(200).json(reels);
    
  } catch (error) {
    console.error("Error fetching 'my reels':", error);
    res.status(500).json({ message: "Server error while fetching reels" });
  }
});

/**
 * @desc    Delete a reel
 * @route   DELETE /api/reels/:id
 * @access  Private
 */
exports.deleteReel = asyncHandler(async (req, res) => {
  const reelId = req.params.id;
  const userId = req.user.id;

  const connection = await pool.getConnection();
  try {
    // التحقق من ملكية الفيديو
    const [reels] = await connection.query(
      "SELECT * FROM reels WHERE id = ? AND user_id = ?",
      [reelId, userId]
    );

    if (reels.length === 0) {
      connection.release();
      return res.status(404).json({ message: "Reel not found or you are not the owner" });
    }

    // الحذف (سيقوم ON DELETE CASCADE بحذف الإعجابات والتعليقات والوسوم المرتبطة)
    await connection.query("DELETE FROM reels WHERE id = ?", [reelId]);
    
    connection.release();
    res.json({ message: "Reel deleted successfully" });
  } catch (error) {
    if (connection) connection.release();
    console.error("Error deleting reel:", error);
    res.status(500).json({ message: "Server error while deleting reel" });
  }
});

/**
 * @desc    Update a reel's caption and tags
 * @route   PUT /api/reels/:id
 * @access  Private
 */
exports.updateReel = asyncHandler(async (req, res) => {
  const reelId = req.params.id;
  const userId = req.user.id;
  const { caption, tagged_products, agreement_id } = req.body; // (نفس بيانات الرفع)

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // التحقق من ملكية الفيديو
    const [reels] = await connection.query(
      "SELECT id FROM reels WHERE id = ? AND user_id = ?",
      [reelId, userId]
    );

    if (reels.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: "Reel not found or not owned by user" });
    }

    // 1. تحديث البيانات الأساسية للفيديو
    await connection.query(
      "UPDATE reels SET caption = ?, agreement_id = ? WHERE id = ?",
      [caption || null, agreement_id || null, reelId]
    );

    // 2. إعادة تعيين المنتجات المرتبطة (الأسهل هو حذف القديم وإضافة الجديد)
    await connection.query("DELETE FROM reel_product_tags WHERE reel_id = ?", [reelId]);

    if (tagged_products && tagged_products !== "[]") {
      const productIds = JSON.parse(tagged_products);
      if (Array.isArray(productIds) && productIds.length > 0) {
        const tagsData = productIds.map((productId) => [reelId, productId]);
        const tagsQuery =
          "INSERT INTO reel_product_tags (reel_id, product_id) VALUES ?";
        await connection.query(tagsQuery, [tagsData]);
      }
    }

    await connection.commit();
    res.json({ message: "Reel updated successfully" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating reel:", error);
    res.status(500).json({ message: "Server error while updating reel" });
  } finally {
    if (connection) connection.release();
  }
});
