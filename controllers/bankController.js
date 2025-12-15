// backend/controllers/bankController.js
const pool = require('../config/db');
const asyncHandler = require('express-async-handler');

// @desc    Get user bank details
// @route   GET /api/bank/details
// @access  Private
exports.getBankDetails = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const [details] = await pool.query("SELECT * FROM bank_details WHERE user_id = ?", [userId]);
  
  if (details.length === 0) {
    return res.status(200).json(null); // لا توجد بيانات بعد
  }
  
  res.json(details[0]);
});

// @desc    Update or Create bank details
// @route   POST /api/bank/details
// @access  Private
exports.updateBankDetails = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { bank_name, account_holder_name, iban, account_number, iban_certificate_url } = req.body;

  // التحقق من البيانات الأساسية
  if (!bank_name || !account_holder_name || !iban) {
    res.status(400);
    throw new Error('يرجى تعبئة الحقول المطلوبة (اسم البنك، اسم صاحب الحساب، الآيبان)');
  }

  // التحقق هل يوجد سجل سابق
  const [existing] = await pool.query("SELECT id FROM bank_details WHERE user_id = ?", [userId]);

  if (existing.length > 0) {
    // تحديث
    await pool.query(
      `UPDATE bank_details SET 
       bank_name = ?, account_holder_name = ?, iban = ?, account_number = ?, 
       iban_certificate_url = ?, status = 'approved', is_verified = 1 
       WHERE user_id = ?`,
      [bank_name, account_holder_name, iban, account_number, iban_certificate_url, userId]
    );
  } else {
    // إنشاء جديد
    await pool.query(
      `INSERT INTO bank_details 
       (user_id, bank_name, account_holder_name, iban, account_number, iban_certificate_url, status) 
       VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
      [userId, bank_name, account_holder_name, iban, account_number, iban_certificate_url]
    );
  }

  res.json({ message: "تم حفظ البيانات البنكية وهي قيد المراجعة" });
});