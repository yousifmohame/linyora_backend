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
  const [rows] = await pool.query(
    "SELECT setting_value FROM site_settings WHERE setting_key = ?",
    [key]
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: "Setting not found" });
  }
  
  // إرجاع القيمة فقط
  res.json(rows[0].setting_value);
});

/**
 * @desc    Update (or create) a setting
 * @route   PUT /api/settings/:key
 * @access  Private/Admin
 */
exports.updateSetting = asyncHandler(async (req, res) => {
  const { key } = req.params;
  const { value } = req.body; // نتوقع { "value": "20" }

  if (value === undefined) {
    return res.status(400).json({ message: "Value is required" });
  }

  // "UPSERT": سيقوم بالإدخال إذا لم يكن موجوداً، أو التحديث إذا كان موجوداً
  const query = `
    INSERT INTO site_settings (setting_key, setting_value) 
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE setting_value = ?
  `;
  
  await pool.query(query, [key, value, value]);
  
  res.json({ setting_key: key, setting_value: value });
});