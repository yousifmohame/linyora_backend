// routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { getNotifications, markAllAsRead } = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// حماية جميع المسارات
router.use(protect);

router.get('/', getNotifications);
router.post('/read', markAllAsRead);

module.exports = router;