const express = require("express");
const router = express.Router();
const {
  createSubscriptionSession,
  cancelSubscription,
  createCheckoutSessionForProducts,
  handlePaymentWebhook,
  createAgreementPaymentIntent,
  createAgreementCheckoutSession,
  verifySession,
} = require("../controllers/paymentController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// مسار للتاجر لإنشاء جلسة دفع
router.post(
  "/create-subscription",
  protect,
  restrictTo(2),
  createSubscriptionSession
);
router.post("/cancel-subscription", protect, restrictTo(2), cancelSubscription);

router.post(
  "/create-checkout-session",
  protect,
  restrictTo(5),
  createCheckoutSessionForProducts
);

// ✨ المسار الجديد ✨
router.post(
  "/create-agreement-intent",
  protect,
  restrictTo(2),
  createAgreementPaymentIntent
);

// ✨ أضف المسار الجديد
router.post(
  "/create-agreement-checkout-session",
  protect,
  restrictTo(2), // متاح للتاجر فقط
  createAgreementCheckoutSession
);

router.route("/verify-session").post(protect, verifySession);

// مسار Webhook لاستقبال تأكيدات الدفع (بدون حماية توكن)
router.post("/webhook", handlePaymentWebhook);

module.exports = router;
