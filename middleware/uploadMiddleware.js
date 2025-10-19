// backend/middleware/uploadMiddleware.js
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../config/cloudinary'); // نستورد إعدادات Cloudinary المركزية

// إعداد مساحة التخزين في Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'linora_platform', // اسم المجلد الذي سيتم حفظ الصور فيه على Cloudinary
    allowed_formats: ['jpg', 'png', 'jpeg', 'pdf'], // الصيغ المسموح بها
    transformation: [{ width: 1024, height: 1024, crop: 'limit' }] // لتصغير حجم الصور الكبيرة
  }
});

// تهيئة Multer مع مساحة التخزين التي أنشأناها
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // يمكنك إضافة شروط هنا للتحقق من الملفات إذا أردت
    cb(null, true);
  }
});

module.exports = upload;