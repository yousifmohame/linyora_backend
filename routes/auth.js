// routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// POST /api/auth/register
router.post('/register', authController.register);

// --- تعديل مسارات تسجيل الدخول ---
// الخطوة 1: التحقق من الإيميل وكلمة المرور وإرسال الكود
router.post('/login', authController.login);

// ✅ --- الإضافة: الخطوة 2: التحقق من الكود وإصدار التوكن
router.post('/verify-login', authController.verifyLogin);

// (مسارات تفعيل الحساب عند التسجيل)
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);

// (مسارات استعادة كلمة المرور)
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);


module.exports = router;