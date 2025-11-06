// backend/routes/messageRoutes.js
const express = require('express');
const router = express.Router();
const { getConversations, getMessages, sendMessage, findOrCreateConversation } = require('../controllers/messageController');
const { protect } = require('../middleware/authMiddleware');

// حماية جميع المسارات
router.use(protect);


router.get('/:conversationId', getMessages);
router.post('/', sendMessage);

router.post('/conversations', findOrCreateConversation); // ✨ أضف هذا السطر
router.get('/', getConversations);

module.exports = router;