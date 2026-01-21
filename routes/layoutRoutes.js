const express = require('express');
const router = express.Router();
const layoutController = require('../controllers/layoutController');
const { protect } = require('../middleware/authMiddleware'); // تأكد من أسماء الميدلوير عندك

// رابط جلب التخطيط (متاح للجميع)
router.get('/home', layoutController.getHomeLayout);

// رابط تحديث التخطيط (محمي للأدمن فقط)
// تأكد أن protect و admin هي الأسماء الصحيحة في ملف middleware/authMiddleware.js
router.post('/home', protect, layoutController.updateHomeLayout);

module.exports = router;
