// routes/reelsRoutes.js
const express = require('express');
const router = express.Router();
const reelsController = require('../controllers/reelsController');
const { protect, optionalProtect } = require('../middleware/authMiddleware'); // <-- 1. استيراد (protect)
const upload = require('../middleware/uploadMiddleware'); // <-- 2. استيراد (upload)

router.get("/my-reels", protect, reelsController.getMyReels);
router.route("/:id")
  .get(optionalProtect, reelsController.getReelById)
  .put(protect, reelsController.updateReel)      // <-- تمت الإضافة
  .delete(protect, reelsController.deleteReel);  // <-- تمت الإضافة


router.route('/:id/share').post(reelsController.incrementShareCount);
// --- (تعديل) مسار جلب كل الفيديوهات ---
router.get('/', optionalProtect, reelsController.getAllReels); // <-- تغيير الدالة و إضافة optionalProtect
// --- (نهاية التعديل) ---
router.route("/:id/products").get(reelsController.getReelProducts);
// جلب الفيديوهات للصفحة الرئيسية (عام)
// router.get('/', reelsController.getReelsForHomepage);

// إضافة فيديو جديد
router.post(
    '/',
    protect,
    upload.single('video'),
    reelsController.uploadReel
);

// --- (إضافة) مسارات الإعجاب وإلغاء الإعجاب ---
router.post('/:id/like', protect, reelsController.likeReel);
router.delete('/:id/like', protect, reelsController.unlikeReel);
// --- (نهاية الإضافة) ---


// --- مسارات سنبنيها لاحقاً ---
router.post('/:id/comment', protect, reelsController.commentOnReel); // إضافة تعليق
router.get('/:id/comments', reelsController.getReelComments);
router.route("/:id/share").post(reelsController.handleShare);

router.post('/like-status', protect, reelsController.getReelsLikeStatus);

module.exports = router;