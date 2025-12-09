// controllers/notificationController.js
const pool = require('../config/db');
const asyncHandler = require("express-async-handler");
// جلب جميع إشعارات المستخدم (الجديدة أولاً)
exports.getNotifications = async (req, res) => {
    try {
        const [notifications] = await pool.query(
            'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
            [req.user.id]
        );
        res.status(200).json(notifications);
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Server error while fetching notifications.' });
    }
};

// تحديد كل الإشعارات كمقروءة
exports.markAllAsRead = async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE',
            [req.user.id]
        );
        res.status(200).json({ message: 'All notifications marked as read.' });
    } catch (error) {
        console.error('Error marking notifications as read:', error);
        res.status(500).json({ message: 'Server error.' });
    }
};


// ✨ [جديد] تحديد إشعار واحد كمقروء
exports.markAsRead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // التحقق من أن الإشعار يخص المستخدم الحالي
    const [result] = await pool.query(
        'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
        [id, req.user.id]
    );

    if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Notification not found or not authorized.' });
    }

    res.status(200).json({ message: 'Notification marked as read.' });
});

// ✨ [جديد] حذف إشعار
exports.deleteNotification = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [result] = await pool.query(
        'DELETE FROM notifications WHERE id = ? AND user_id = ?',
        [id, req.user.id]
    );

    if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Notification not found.' });
    }

    res.status(200).json({ message: 'Notification deleted successfully.' });
});