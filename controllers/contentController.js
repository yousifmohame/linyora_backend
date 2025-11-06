const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

// @desc    Get content by key
// @route   GET /api/content/:key
// @access  Public
const getContentByKey = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const [rows] = await pool.query(
    "SELECT title, content FROM site_content WHERE section_key = ? AND is_visible = TRUE",
    [key]
  );

  if (rows.length > 0) {
    res.json(rows[0]);
  } else {
    res.status(404);
    throw new Error("Content not found");
  }
});

// @desc    Get all content for admin
// @route   GET /api/content
// @access  Admin
const getAllContent = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, section_key, title, is_visible FROM site_content"
  );
  res.json(rows);
});

// @desc    Update content by key
// @route   PUT /api/content/:key
// @access  Admin
const updateContent = asyncHandler(async (req, res) => {
  const { key } = req.params;
  
  // ✅ [FIX] استخراج البيانات من الـ body
  // لاحظ أننا نفترض أن title و is_visible قد لا يتم إرسالهما من فورم الفوتر
  // لذا نعطيهما قيم افتراضية
  const { content } = req.body;
  const title = req.body.title || key; // استخدام المفتاح كعنوان افتراضي
  const is_visible = req.body.is_visible !== undefined ? req.body.is_visible : true;

  // ❌ الكود القديم الذي كان يفشل
  // await pool.query(
  //   "UPDATE site_content SET title = ?, content = ?, is_visible = ? WHERE section_key = ?",
  //   [title, content, is_visible, key]
  // );

  // ✅ [FIX] استخدام "UPSERT" (INSERT ... ON DUPLICATE KEY UPDATE)
  // هذا سيقوم بإنشاء السجل إذا لم يكن موجودًا، أو تحديثه إذا كان موجودًا
  const query = `
    INSERT INTO site_content (section_key, title, content, is_visible) 
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      content = VALUES(content),
      is_visible = VALUES(is_visible)
  `;
  
  await pool.query(query, [key, title, content, is_visible]);

  res.json({ message: "Content updated successfully" });
});

module.exports = {
  getContentByKey,
  getAllContent,
  updateContent,
};