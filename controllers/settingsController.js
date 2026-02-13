// backend/controllers/settingsController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

/**
 * @desc    Get a specific setting value
 * @route   GET /api/settings/:key
 * @access  Public
 */
exports.getSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;

  // ✅ تصحيح: استخدام platform_settings بدلاً من site_settings
  const [rows] = await pool.query(
    "SELECT setting_value FROM platform_settings WHERE setting_key = ?",
    [key],
  );

  if (rows.length === 0) {
    // إرجاع قيمة افتراضية 0 بدلاً من خطأ 404 لتجنب كسر الفرونت إند
    return res.json("0");
  }

  // إرجاع القيمة مباشرة
  res.json(rows[0].setting_value);
});

/**
 * @desc    Update (or create) a setting
 * @route   PUT /api/settings/:key
 * @access  Private/Admin
 */
exports.updateSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === undefined) {
    return res.status(400).json({ message: "Value is required" });
  }

  // ✅ تصحيح: استخدام platform_settings
  const query = `
    INSERT INTO platform_settings (setting_key, setting_value) 
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE setting_value = ?
  `;

  await pool.query(query, [key, String(value), String(value)]);

  res.json({ setting_key: key, setting_value: value });
});
