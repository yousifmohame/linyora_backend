// controllers/storyController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

// @desc    إنشاء قسم قصص جديد (للأدمن فقط)
// @route   POST /api/stories/sections
exports.createSection = asyncHandler(async (req, res) => {
  const { title } = req.body;
  const cover_image = req.file ? req.file.path : null;

  if (!title) {
    res.status(400);
    throw new Error("عنوان القسم مطلوب");
  }

  const [result] = await pool.query(
    "INSERT INTO story_sections (title, cover_image) VALUES (?, ?)",
    [title, cover_image]
  );

  res.status(201).json({ id: result.insertId, title, cover_image });
});

// @desc    إضافة قصة جديدة (لجميع المستخدمين)
// @route   POST /api/stories
exports.createStory = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  
  // --- (تصحيح هام) ---
  // نحاول الحصول على الدور سواء كان اسمه role أو role_id
  // ونضمن التعامل معه سواء كان رقم أو نص
  const userRole = req.user.role || req.user.role_id; 

  const { type, text_content, background_color, product_id, section_id } = req.body;
  
  // التعامل مع الملفات المرفوعة (صورة/فيديو)
  // uploadMiddleware يضع الملف في req.file
  const media_url = req.file ? req.file.path : null;

  // التحقق من أن الأدمن فقط من يضيف لـ Section
  let validSectionId = null;

  // التحقق من أن section_id موجود وقيمته ليست 'undefined' أو 'null' كنص
  if (section_id && section_id !== 'null' && section_id !== 'undefined') {
      // التحقق من الصلاحية (نستخدم == للمقارنة المرنة بين "1" و 1)
      if (userRole === 'admin' || userRole == 1) {
          validSectionId = section_id;
      }
  }

  // تحديد مدة انتهاء القصة (24 ساعة)
  const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const query = `
    INSERT INTO stories 
    (user_id, section_id, type, media_url, text_content, background_color, product_id, expires_at) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const [result] = await pool.query(query, [
    userId,
    validSectionId, // سيتم تخزين رقم القسم هنا إذا نجح التحقق
    type || 'image',
    media_url,
    text_content,
    background_color,
    product_id || null,
    expires_at
  ]);

  res.status(201).json({ message: "تم نشر القصة بنجاح", storyId: result.insertId });
});

// @desc    جلب القصص للصفحة الرئيسية (مجمعة)
// @route   GET /api/stories/feed
// @desc    جلب القصص للصفحة الرئيسية (مجمعة)
// @route   GET /api/stories/feed
exports.getStoriesFeed = asyncHandler(async (req, res) => {
  const currentUserId = req.user ? req.user.id : null;

  try {
    // 1. جلب أقسام الأدمن (مع حساب المشاهدات الآن)
    const [adminSections] = await pool.query(`
      SELECT 
        ss.id, ss.title, ss.cover_image, 
        TRUE as isAdminSection,
        -- حساب عدد القصص في القسم
        (SELECT COUNT(*) FROM stories s WHERE s.section_id = ss.id AND s.expires_at > NOW() AND s.is_active = 1) as storyCount,
        -- ✅ الإضافة الجديدة: حساب عدد القصص التي شاهدها المستخدم في هذا القسم
        ${currentUserId ? `(
            SELECT COUNT(*) 
            FROM story_views sv 
            JOIN stories st ON sv.story_id = st.id 
            WHERE st.section_id = ss.id 
            AND sv.viewer_id = ? 
            AND st.expires_at > NOW()
            AND st.is_active = 1
        )` : '0'} as viewedCount
      FROM story_sections ss
      WHERE ss.is_active = 1
      ORDER BY ss.sort_order ASC
    `, currentUserId ? [currentUserId] : []);

    // تصفية الأقسام الفارغة وحساب allViewed
    const formattedAdminSections = adminSections
      .filter(sec => sec.storyCount > 0)
      .map(sec => ({
        ...sec,
        // ✅ الآن سيتم حساب هذا بشكل صحيح للأدمن أيضاً
        allViewed: sec.viewedCount >= sec.storyCount 
      }));

    // 2. جلب قصص المستخدمين (كما هي)
    const [userStories] = await pool.query(`
      SELECT 
        u.id as id, 
        u.name as userName, 
        u.profile_picture_url as userAvatar, 
        u.role_id,
        MAX(s.created_at) as latestStoryTime,
        COUNT(s.id) as storyCount,
        FALSE as isAdminSection,
        ${currentUserId ? `(
            SELECT COUNT(*) 
            FROM story_views sv 
            JOIN stories st ON sv.story_id = st.id 
            WHERE st.user_id = u.id 
            AND sv.viewer_id = ? 
            AND st.expires_at > NOW()
            AND st.is_active = 1
            AND st.section_id IS NULL
        )` : '0'} as viewedCount
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.section_id IS NULL 
      AND s.expires_at > NOW() 
      AND s.is_active = 1
      GROUP BY u.id
      ORDER BY latestStoryTime DESC
    `, currentUserId ? [currentUserId] : []);

    const formattedUserStories = userStories.map(user => ({
      ...user,
      allViewed: user.viewedCount >= user.storyCount
    }));

    // دمج القائمتين
    const feed = [...formattedAdminSections, ...formattedUserStories];

    res.status(200).json(feed);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "فشل جلب القصص" });
  }
});

// @desc    جلب تفاصيل قصص (عند النقر على الدائرة)
exports.getStoriesById = asyncHandler(async (req, res) => {
    const { id } = req.params; 
    const { type } = req.query; 
    const viewerId = req.user ? req.user.id : null;

    let query = '';
    let params = [];

    // ✅ تم التعديل هنا: إصلاح خطأ p.price باستخدام Subqueries
    const baseSelect = `
        SELECT s.*, 
        p.name as product_name, 
        
        -- جلب السعر من جدول المتغيرات (أول متغير)
        (SELECT price FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1) as product_price,
        
        -- جلب الصورة من جدول المتغيرات
        (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]')) FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1) as product_image,
        
        ${viewerId ? `(SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id AND sv.viewer_id = ?) > 0` : 'FALSE'} as isViewed
        FROM stories s
        LEFT JOIN products p ON s.product_id = p.id
    `;

    if (type === 'section') {
        query = `${baseSelect} WHERE s.section_id = ? AND s.expires_at > NOW() AND s.is_active = 1 ORDER BY s.created_at ASC`;
        params = viewerId ? [viewerId, id] : [id];
    } else {
        query = `${baseSelect} WHERE s.user_id = ? AND s.section_id IS NULL AND s.expires_at > NOW() AND s.is_active = 1 ORDER BY s.created_at ASC`;
        params = viewerId ? [viewerId, id] : [id];
    }

    const [stories] = await pool.query(query, params);
    
    const result = stories.map(s => ({...s, isViewed: Boolean(s.isViewed)}));

    res.status(200).json(result);
});

// @desc تسجيل مشاهدة لقصة
exports.markStorySeen = asyncHandler(async (req, res) => {
    const { storyId } = req.body;
    const viewerId = req.user.id;

    try {
        await pool.query(
            "INSERT IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)",
            [storyId, viewerId]
        );
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ message: "Error marking view" });
    }
});

// @desc    جلب جميع الأقسام (للأدمن)
// @route   GET /api/stories/sections
exports.getSections = asyncHandler(async (req, res) => {
  const [sections] = await pool.query(`
    SELECT 
      ss.*,
      (SELECT COUNT(*) FROM stories s WHERE s.section_id = ss.id AND s.expires_at > NOW() AND s.is_active = 1) as storyCount
    FROM story_sections ss
    WHERE ss.is_active = 1
    ORDER BY ss.sort_order ASC, ss.created_at DESC
  `);
  res.status(200).json(sections);
});

// @desc    حذف قسم قصص
// @route   DELETE /api/stories/sections/:id
exports.deleteSection = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  // سيتم حذف القصص المرتبطة تلقائياً إذا كان foreign key مضبوطاً على ON DELETE CASCADE
  // أو يمكنك تحديثها لتصبح NULL
  await pool.query("DELETE FROM story_sections WHERE id = ?", [id]);
  
  res.status(200).json({ message: "تم حذف القسم بنجاح" });
});

// @desc    جلب القصص النشطة للمستخدم الحالي (أدمن أو غيره)
// @route   GET /api/stories/my-stories
exports.getMyStories = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  
  const [stories] = await pool.query(`
      SELECT 
        s.*, 
        ss.title as section_title,
        (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id) as views
      FROM stories s
      LEFT JOIN story_sections ss ON s.section_id = ss.id
      WHERE s.user_id = ? 
      AND s.expires_at > NOW() 
      AND s.is_active = 1
      ORDER BY s.created_at DESC
  `, [userId]);

  res.status(200).json(stories);
});

// @desc    حذف قصة
// @route   DELETE /api/stories/:id
exports.deleteStory = asyncHandler(async (req, res) => {
  const storyId = req.params.id;
  const userId = req.user.id;
  const userRole = req.user.role; // تأكد من طريقة جلب الرول في نظامك

  // التحقق من الملكية (إلا إذا كان أدمن يمكنه حذف أي قصة)
  let query = "DELETE FROM stories WHERE id = ?";
  let params = [storyId];

  if (userRole !== 'admin' && userRole !== 1) {
     query += " AND user_id = ?";
     params.push(userId);
  }

  const [result] = await pool.query(query, params);

  if (result.affectedRows === 0) {
      res.status(404);
      throw new Error("القصة غير موجودة أو لا تملك صلاحية حذفها");
  }

  res.status(200).json({ message: "تم حذف القصة" });
});