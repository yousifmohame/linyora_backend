// backend/middleware/uploadMiddleware.js
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const {cloudinary} = require('../config/cloudinary'); // <-- هذا هو التعديل

console.log("--- MW: الدخول إلى uploadMiddleware (إعداد) ---"); // (Log من الخطوة السابقة)

// إعداد مساحة التخزين في Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary, // الآن يجب أن يكون هذا الكائن معرفاً وصحيحاً
  params: async (req, file) => { // <-- (تعديل إضافي مهم جداً) جعل هذه الدالة async
    console.log(`--- MW: CloudinaryStorage - معالجة ملف: ${file.originalname} ---`); // (Log من الخطوة السابقة)
    
    // تحديد المجلد بناءً على نوع الرفع (هذا منطق جيد!)
    let folder = 'linora_platform/other';
    if (file.fieldname === 'video') { // <-- التحقق من اسم الحقل مهم
      folder = 'linora_platform/reels';
    } else if (['image', 'images', 'profile_picture', 'store_logo_url', 'store_banner_url'].includes(file.fieldname)) { // توسيع التحقق للصور
        folder = 'linora_platform/images';
    } else if (['identity_image_url', 'iban_certificate_url', 'identity_document_url', 'business_license_url'].includes(file.fieldname)) { // توسيع التحقق للمستندات
        folder = 'linora_platform/documents';
    }
    
    console.log(`--- MW: سيتم الرفع إلى المجلد: ${folder} ---`); // (Log من الخطوة السابقة)

    return {
      folder: folder,
      resource_type: file.fieldname === 'video' ? 'video' : 'auto', // <-- (تعديل) السماح لـ Cloudinary بتحديد نوع المورد للصور والمستندات
      allowed_formats: file.fieldname === 'video' ? ['mp4', 'mov', 'mkv'] : ['jpg', 'png', 'jpeg', 'pdf'], // <-- (تعديل) صيغ مختلفة للفيديو والصور
      public_id: `${Date.now()}-${file.originalname.split('.')[0]}` // اسم فريد للملف
      // transformation: [{ width: 1024, height: 1024, crop: 'limit' }] // <-- (ملاحظة) هذا التحويل قد لا يعمل جيداً للفيديو أو الـ PDF، ربما تزيله أو تجعله شرطياً
    };
  }
});

// تهيئة Multer مع مساحة التخزين التي أنشأناها
const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 1000 * 1024 * 1024 // 100 MB
  },
  fileFilter: (req, file, cb) => {
    console.log(`--- MW: Multer fileFilter - التحقق من ملف: ${file.mimetype} ---`); // (Log من الخطوة السابقة)
    // يمكنك إضافة شروط هنا للتحقق من الملفات إذا أردت
    cb(null, true);
  }
});

module.exports = upload;