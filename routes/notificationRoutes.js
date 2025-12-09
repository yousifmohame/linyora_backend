// routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { 
    getNotifications, 
    markAllAsRead, 
    markAsRead, 
    deleteNotification 
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

// 1. جلب الإشعارات
router.get('/', getNotifications);

// 2. تصحيح المسار ليتطابق مع الفرونت إند (PUT /mark-all-read)
router.post('/read', markAllAsRead);

// 3. إضافة مسار قراءة إشعار محدد (PUT /:id/read)
router.put('/:id/read', markAsRead);

// 4. إضافة مسار الحذف (DELETE /:id)
router.delete('/:id', deleteNotification);

module.exports = router;

module.exports = router;