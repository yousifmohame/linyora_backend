// backend/controllers/messageController.js
const pool = require('../config/db');
const sendEmail = require('../utils/emailService');
const templates = require("../utils/emailTemplates");

// [GET] جلب جميع محادثات المستخدم
exports.getConversations = async (req, res) => {
    const userId = req.user.id;
    try {
        const [conversations] = await pool.query(
            `SELECT 
                c.id,
                IF(c.merchant_id = ?, u_model.id, u_merchant.id) AS participantId,
                IF(c.merchant_id = ?, u_model.name, u_merchant.name) AS participantName,
                IF(c.merchant_id = ?, u_model.profile_picture_url, u_merchant.profile_picture_url) AS participantAvatar,
                u_other.is_online,
                u_other.last_seen,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as lastMessage
             FROM conversations c
             JOIN users u_merchant ON c.merchant_id = u_merchant.id
             JOIN users u_model ON c.model_id = u_model.id
             JOIN users u_other ON u_other.id = IF(c.merchant_id = ?, c.model_id, c.merchant_id)
             WHERE c.merchant_id = ? OR c.model_id = ?
             ORDER BY c.updated_at DESC`,
            [userId, userId, userId, userId, userId, userId]
        );
        res.status(200).json(conversations);
    } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({ message: 'خطأ في جلب المحادثات' });
    }
};

// [GET] جلب الرسائل داخل محادثة معينة
exports.getMessages = async (req, res) => {
    const { conversationId } = req.params;
    const userId = req.user.id;
    try {
        const [convoCheck] = await pool.query(
            'SELECT id FROM conversations WHERE id = ? AND (merchant_id = ? OR model_id = ?)',
            [conversationId, userId, userId]
        );
        if (convoCheck.length === 0) {
            return res.status(403).json({ message: 'غير مصرح لك بالوصول لهذه المحادثة' });
        }
        const [messages] = await pool.query(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
            [conversationId]
        );
        res.status(200).json(messages);
    } catch (error) {
        res.status(500).json({ message: 'خطأ في جلب الرسائل' });
    }
};

// [POST] إرسال رسالة جديدة (نسخة محسنة)
exports.sendMessage = async (req, res) => {
    const { receiverId, body, attachment_url, attachment_type } = req.body;
    const senderId = req.user.id;

    if (!receiverId || (!body && !attachment_url)) {
        return res.status(400).json({ message: "Missing required fields." });
    }

    const io = req.app.get('io');
    const userSocketMap = req.app.get('userSocketMap');
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [userRoles] = await connection.query('SELECT id, role_id, email, name FROM users WHERE id IN (?, ?)', [senderId, receiverId]);
        const sender = userRoles.find(u => u.id === senderId);
        const receiver = userRoles.find(u => u.id === receiverId);

        if (!sender || !receiver) {
            await connection.rollback();
            return res.status(404).json({ message: "Sender or receiver not found." });
        }

        let merchant_id, model_id;
        if (sender.role_id === 2 && [3, 4].includes(receiver.role_id)) {
            merchant_id = sender.id;
            model_id = receiver.id;
        } else if ([3, 4].includes(sender.role_id) && receiver.role_id === 2) {
            merchant_id = receiver.id;
            model_id = sender.id;
        } else {
            await connection.rollback();
            return res.status(403).json({ message: "Messaging is only allowed between Merchants and Models/Influencers." });
        }

        let [conversations] = await connection.query(
            'SELECT id FROM conversations WHERE merchant_id = ? AND model_id = ?',
            [merchant_id, model_id]
        );

        let conversationId;
        if (conversations.length > 0) {
            conversationId = conversations[0].id;
        } else {
            const [newConvoResult] = await connection.query(
                'INSERT INTO conversations (merchant_id, model_id) VALUES (?, ?)',
                [merchant_id, model_id]
            );
            conversationId = newConvoResult.insertId;
        }

        const [messageResult] = await connection.query(
            'INSERT INTO messages (conversation_id, sender_id, receiver_id, body, attachment_url, attachment_type) VALUES (?, ?, ?, ?, ?, ?)',
            [conversationId, senderId, receiverId, body || null, attachment_url || null, attachment_type || null]
        );

        await connection.commit();
        
        const newMessage = {
            id: messageResult.insertId,
            conversation_id: conversationId,
            sender_id: senderId,
            receiver_id: receiverId,
            body: body || null,
            attachment_url: attachment_url || null,
            attachment_type: attachment_type || null,
            is_read: false,
            created_at: new Date().toISOString()
        };

        const receiverSocketId = userSocketMap[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('newMessage', newMessage);
        } else {
            try {
                const [users] = await pool.query("SELECT email, name FROM users WHERE id IN (?, ?)", [senderId, receiverId]);
                const sender = users.find(u => u.id === senderId); // انتبه: الـ query لا تعيد ID افتراضياً إذا لم تطلبه، تأكد من الـ SELECT
                // الأفضل جلب البيانات بشكل صريح:
                const [[senderData]] = await pool.query("SELECT name FROM users WHERE id = ?", [senderId]);
                const [[receiverData]] = await pool.query("SELECT name, email FROM users WHERE id = ?", [receiverId]);

                if (receiverData && senderData) {
                    // نرسل جزء من الرسالة كمعاينة (أول 50 حرف)
                    const preview = body ? (body.length > 50 ? body.substring(0, 50) + "..." : body) : "ملف مرفق";

                    sendEmail({
                        to: receiverData.email,
                        subject: `رسالة جديدة من ${senderData.name}`,
                        html: templates.newMessageNotification(receiverData.name, senderData.name, preview)
                    }).catch(console.error);
                }
            } catch (mailError) {
                console.error("Failed to send offline message email:", mailError);
            }
        }

        res.status(201).json({ message: 'Message sent successfully.', data: newMessage });

    } catch (error) {
        if(connection) await connection.rollback();
        console.error("Error sending message:", error);
        res.status(500).json({ message: 'Error sending message.' });
    } finally {
        if (connection) connection.release();
    }
};

// [POST] البحث عن محادثة أو إنشاؤها
exports.findOrCreateConversation = async (req, res) => {
    const { participantId } = req.body;
    const initiatorId = req.user.id;

    if (!participantId) {
        return res.status(400).json({ message: "Participant ID is required." });
    }

    try {
        const [userRoles] = await pool.query('SELECT id, role_id FROM users WHERE id IN (?, ?)', [initiatorId, participantId]);
        const initiator = userRoles.find(u => u.id === initiatorId);
        const participant = userRoles.find(u => u.id === participantId);

        if (!initiator || !participant) {
            return res.status(404).json({ message: "User not found." });
        }
        
        let merchant_id, model_id;
        if (initiator.role_id === 2 && [3, 4].includes(participant.role_id)) {
            merchant_id = initiator.id;
            model_id = participant.id;
        } else if ([3, 4].includes(initiator.role_id) && participant.role_id === 2) {
            merchant_id = participant.id;
            model_id = initiator.id;
        } else {
            return res.status(403).json({ message: "Invalid participant roles for conversation." });
        }
        
        let [conversation] = await pool.query(
            'SELECT id FROM conversations WHERE merchant_id = ? AND model_id = ?',
            [merchant_id, model_id]
        );

        if (conversation.length > 0) {
            return res.status(200).json({ conversationId: conversation[0].id });
        } else {
            const [newConvo] = await pool.query(
                'INSERT INTO conversations (merchant_id, model_id) VALUES (?, ?)',
                [merchant_id, model_id]
            );
            return res.status(201).json({ conversationId: newConvo.insertId });
        }
    } catch (error) {
        console.error("Error finding or creating conversation:", error);
        res.status(500).json({ message: 'Server error' });
    }
};
