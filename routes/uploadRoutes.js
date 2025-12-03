// backend/routes/uploadRoutes.js
const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../config/cloudinary');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

// --- إعدادات رفع صور المنتجات (الحالية) ---
const productStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'linora-products',
        allowed_formats: ['jpeg', 'png', 'jpg', 'webp', 'mp4', 'webm', 'gif'],
        resource_type: 'auto' 
    }
});
const uploadProduct = multer({ storage: productStorage });

// --- ✨ إعدادات جديدة لرفع مرفقات الدردشة ---
const attachmentStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'linora-attachments', // مجلد منفصل للمرفقات
        // السماح بأنواع ملفات أكثر تنوعًا
        allowed_formats: ['jpeg', 'png', 'jpg', 'pdf', 'doc', 'docx'] 
    }
});
const uploadAttachment = multer({ storage: attachmentStorage });


// POST /api/upload - لرفع صور المنتجات وصور الملفات الشخصية
router.post('/', protect, uploadProduct.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    // إرجاع الرابط الآمن ونوعه
    res.status(200).json({ 
        imageUrl: req.file.path,
        imageType: req.file.mimetype 
    });
});

// ✨--- مسار جديد لرفع مرفقات الرسائل ---✨
// POST /api/upload/attachment
router.post('/attachment', protect, uploadAttachment.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    res.status(200).json({ 
        attachment_url: req.file.path, 
        attachment_type: req.file.mimetype.split('/')[0] // 'image', 'application', etc.
    });
});


module.exports = router;