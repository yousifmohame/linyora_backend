// backend/middleware/uploadMiddleware.js
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../config/cloudinary');

console.log("--- MW: Upload Middleware Initialized ---");

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    console.log(`--- MW: Processing file: ${file.originalname} | Field: ${file.fieldname} | Type: ${file.mimetype} ---`);
    
    // 1. تحديد هل الملف فيديو أم لا
    const isVideo = file.fieldname === 'video' || file.mimetype.startsWith('video/');

    let folder = 'linora_platform/other';
    let resource_type = 'auto'; 
    let allowed_formats = ['jpg', 'png', 'jpeg', 'pdf', 'webp'];

    // 2. منطق التوجيه للمجلدات وتحديد النوع
    if (file.fieldname === 'media') {
        // خاص بالقصص (Stories)
        folder = 'linora_platform/stories';
        if (isVideo) {
            resource_type = 'video';
            allowed_formats = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
        } else {
            resource_type = 'image';
            allowed_formats = ['jpg', 'png', 'jpeg', 'webp'];
        }
    } else if (['image', 'images', 'profile_picture', 'store_logo_url', 'store_banner_url'].includes(file.fieldname)) {
        // ✨ التعديل هنا: التحقق إذا كان "image" في الحقيقة فيديو (مثل البانرات)
        if (isVideo) {
            folder = 'linora_platform/banners_video'; // مجلد خاص لفيديوهات البانر
            resource_type = 'video';
            allowed_formats = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
        } else {
            folder = 'linora_platform/images';
            resource_type = 'image';
            allowed_formats = ['jpg', 'png', 'jpeg', 'webp'];
        }
    } else if (isVideo) {
        // أي فيديو آخر لم يتم تحديد حقل له
        folder = 'linora_platform/reels';
        resource_type = 'video';
        allowed_formats = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
    } else if (['identity_image_url', 'iban_certificate_url', 'identity_document_url', 'business_license_url'].includes(file.fieldname)) {
        folder = 'linora_platform/documents';
        allowed_formats = ['jpg', 'png', 'jpeg', 'pdf'];
    }

    console.log(`--- MW: Uploading to folder: ${folder} as ${resource_type} ---`);

    return {
      folder: folder,
      resource_type: resource_type,
      allowed_formats: allowed_formats,
      // الحفاظ على الاسم الأصلي أو إنشاء اسم فريد
      public_id: `${Date.now()}-${file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, "_")}`
    };
  }
});

const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100 MB (كافٍ للفيديوهات القصيرة)
  },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

module.exports = upload;