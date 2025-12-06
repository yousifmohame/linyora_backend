// backend/middleware/uploadMiddleware.js
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('../config/cloudinary');

console.log("--- MW: Upload Middleware Initialized ---");

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    console.log(`--- MW: Processing file: ${file.originalname} | Field: ${file.fieldname} | Type: ${file.mimetype} ---`);
    
    let folder = 'linora_platform/other';
    let resource_type = 'auto'; // دع Cloudinary يقرر النوع مبدئياً
    let allowed_formats = ['jpg', 'png', 'jpeg', 'pdf', 'webp']; // الصيغ الافتراضية

    // 1. التحقق مما إذا كان الملف فيديو (سواء من اسم الحقل أو نوع الملف)
    const isVideo = file.fieldname === 'video' || file.mimetype.startsWith('video/');

    if (isVideo) {
        folder = 'linora_platform/reels'; // مجلد الفيديوهات الافتراضي
        resource_type = 'video';
        allowed_formats = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
    } 
    
    // 2. تخصيص المجلدات بناءً على اسم الحقل
    if (file.fieldname === 'media') {
        // هذا خاص بالقصص (Stories) حيث يمكن أن يكون فيديو أو صورة
        folder = 'linora_platform/stories';
        if (isVideo) {
            resource_type = 'video';
            allowed_formats = ['mp4', 'mov', 'mkv', 'avi', 'webm'];
        } else {
            resource_type = 'image';
            allowed_formats = ['jpg', 'png', 'jpeg', 'webp'];
        }
    } else if (['image', 'images', 'profile_picture', 'store_logo_url', 'store_banner_url'].includes(file.fieldname)) {
        folder = 'linora_platform/images';
        resource_type = 'image';
        allowed_formats = ['jpg', 'png', 'jpeg', 'webp'];
    } else if (['identity_image_url', 'iban_certificate_url', 'identity_document_url', 'business_license_url'].includes(file.fieldname)) {
        folder = 'linora_platform/documents';
        // المستندات قد تكون صور أو PDF
        allowed_formats = ['jpg', 'png', 'jpeg', 'pdf'];
    }

    console.log(`--- MW: Uploading to folder: ${folder} as ${resource_type} ---`);

    return {
      folder: folder,
      resource_type: resource_type,
      allowed_formats: allowed_formats,
      public_id: `${Date.now()}-${file.originalname.split('.')[0].replace(/[^a-zA-Z0-9]/g, "_")}` // تنظيف الاسم
    };
  }
});

const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100 MB Limit
  },
  fileFilter: (req, file, cb) => {
    // يمكنك رفض الملفات هنا إذا لزم الأمر، حالياً نقبل الجميع لأن Cloudinary سيفلتر الصيغ
    cb(null, true);
  }
});

module.exports = upload;