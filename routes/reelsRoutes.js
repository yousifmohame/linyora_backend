const express = require('express');
const router = express.Router();
const reelsController = require('../controllers/reelsController');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware');

// ============================================================
// 1. المسارات العامة والثابتة (يجب أن تكون في البداية)
// ============================================================

// جلب كل الفيديوهات (الرئيسية)
router.get('/', optionalProtect, reelsController.getAllReels);

// رفع فيديو جديد
router.post('/', protect, upload.single('video'), reelsController.uploadReel);

// جلب فيديوهاتي (يجب أن يكون قبل /:id لتجنب اعتباره كـ id)
router.get("/my-reels", protect, reelsController.getMyReels);

// التحقق من حالة الإعجاب لمجموعة فيديوهات
router.post('/like-status', protect, reelsController.getReelsLikeStatus);


// ============================================================
// 2. العمليات الفرعية على فيديو محدد (/:id/action)
// ============================================================

// ✅ تسجيل المشاهدة (هذا هو المسار الذي كنت تواجه مشكلة فيه)
router.post('/:id/view', reelsController.incrementViewCount);

// المنتجات المرتبطة بالفيديو
router.get("/:id/products", reelsController.getReelProducts);

// الإعجاب وإلغاء الإعجاب
router.post('/:id/like', protect, reelsController.likeReel);
router.delete('/:id/like', protect, reelsController.unlikeReel);

// التعليقات
router.post('/:id/comment', protect, reelsController.commentOnReel);
router.get('/:id/comments', reelsController.getReelComments);

// المشاركة (كان مكرراً في كودك، تم توحيده هنا)
router.post('/:id/share', reelsController.incrementShareCount);


// ============================================================
// 3. العمليات المباشرة على المعرف (يجب أن تكون في النهاية)
// ============================================================

router.route("/:id")
  .get(optionalProtect, reelsController.getReelById)  // جلب تفاصيل فيديو
  .put(protect, reelsController.updateReel)           // تعديل فيديو
  .delete(protect, reelsController.deleteReel);       // حذف فيديو

module.exports = router;
