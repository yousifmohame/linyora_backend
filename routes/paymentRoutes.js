const express = require("express");
const router = express.Router();
const {
  createSubscriptionSession,
  cancelSubscription,
  createCheckoutSessionForProducts,
  handlePaymentWebhook,
  createAgreementPaymentIntent,
  createAgreementCheckoutSession,
  getPaymentMethods,
  createSetupIntent,
  createPaymentIntent,
  deletePaymentMethod,
  setDefaultPaymentMethod,
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

router.post("/webhook", handlePaymentWebhook);

router.get("/methods", protect, getPaymentMethods);
router.post("/setup-intent", protect, createSetupIntent);
router.post("/create-intent", protect, createPaymentIntent);
router.delete("/methods/:id", protect, deletePaymentMethod);
router.put("/methods/:id/default", protect, setDefaultPaymentMethod);

// مسار Webhook لاستقبال تأكيدات الدفع (بدون حماية توكن)

module.exports = router;
