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
  const { title, content, is_visible } = req.body;

  await pool.query(
    "UPDATE site_content SET title = ?, content = ?, is_visible = ? WHERE section_key = ?",
    [title, content, is_visible, key]
  );

  res.json({ message: "Content updated successfully" });
});

module.exports = {
  getContentByKey,
  getAllContent,
  updateContent,
};
