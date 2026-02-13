// routes/agreementRoutes.js
const express = require("express");
const router = express.Router();
const {
  createAgreement,
  getAgreementRequests,
  completeAgreementByMerchant,
  getMerchantAgreements,
  createAgreementReview,
  getActiveAgreementsForUser,
  respondToAgreement,
  startAgreementProgress,
  deliverAgreement,
} = require("../controllers/agreementController");

const { protect, restrictTo } = require("../middleware/authMiddleware");

// 1. مسار للتاجر لإنشاء اتفاق
// (Merchant Only - ID: 2)
router.post("/", protect, restrictTo(2), createAgreement);

// 2. مسارات للعارضة/المؤثرة لجلب الطلبات
// (Supplier/Model - IDs: 3, 4)
router.get("/requests", protect, restrictTo(3, 4), getAgreementRequests);

// 3. ✨ الرد على الاتفاق (قبول/رفض) - بديل المسار القديم updateAgreementStatus
// (Supplier/Model - IDs: 3, 4)
router.put(
  "/:id/respond",
  protect,
  restrictTo(3, 4),
  respondToAgreement
);

// 4. ✨ بدء التنفيذ (بعد القبول)
// (Supplier/Model - IDs: 3, 4)
router.put(
  "/:id/start",
  protect,
  restrictTo(3, 4),
  startAgreementProgress
);

// 5. ✨ تسليم العمل (بعد الانتهاء)
// (Supplier/Model - IDs: 3, 4)
router.put(
  "/:id/deliver",
  protect,
  restrictTo(3, 4),
  deliverAgreement
);

// 6. ✨ مسار للتاجر لتأكيد الاكتمال وتحرير الأموال
// (Merchant Only - ID: 2)
router.put(
  "/:id/complete",
  protect,
  restrictTo(2),
  completeAgreementByMerchant
);

// 7. جلب اتفاقيات التاجر
// (Merchant Only - ID: 2)
router.get(
  "/my-agreements",
  protect,
  restrictTo(2),
  getMerchantAgreements
);

// 8. جلب الاتفاقيات النشطة للمستخدم الحالي (لأي مستخدم مسجل دخول)
router.get("/active-for-user", protect, getActiveAgreementsForUser);

// 9. إضافة تقييم
router.post("/:id/review", protect, createAgreementReview);

module.exports = router;