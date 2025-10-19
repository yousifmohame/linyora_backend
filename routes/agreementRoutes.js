// routes/agreementRoutes.js
const express = require("express");
const router = express.Router();
const {
  createAgreement,
  getAgreementRequests,
  updateAgreementStatus,
  completeAgreementByMerchant,
  getMerchantAgreements,
  createAgreementReview,
} = require("../controllers/agreementController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// مسار للتاجر لإنشاء اتفاق
router.post("/", protect, restrictTo(2), createAgreement);

// مسارات للعارضة/المؤثرة لإدارة الطلبات
router.get("/requests", protect, restrictTo(3, 4), getAgreementRequests);
router.put(
  "/requests/:id/status",
  protect,
  restrictTo(3, 4),
  updateAgreementStatus
);

// --- ✨ المسار الجديد للتاجر لتأكيد اكتمال الاتفاق ✨ ---
router.put(
  "/:id/complete",
  protect,
  restrictTo(2), // متاح للتاجر فقط
  completeAgreementByMerchant
);

// --- ✨ New route for merchants to view their agreements ---
router.get(
  "/my-agreements",
  protect,
  restrictTo(2), // Merchant only
  getMerchantAgreements
);

router.post("/:id/review", protect, createAgreementReview);

module.exports = router;
