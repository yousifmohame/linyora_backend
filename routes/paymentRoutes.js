// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const {
  // Web Controllers
  createSubscriptionSession,
  createCheckoutSessionForProducts,
  createAgreementCheckoutSession,

  // Mobile Controllers
  createMobilePaymentIntent,
  createMobileSetupIntent,
  createMobileSubscription,
  createMobileAgreementIntent,
  createMobilePromotionIntent,

  // Shared / Utilities
  cancelSubscription,
  getPaymentMethods,
  createSetupIntent,
  createPaymentIntent,
  deletePaymentMethod,
  setDefaultPaymentMethod,
  createAgreementPaymentIntent,
} = require("../controllers/paymentController");

const { protect, restrictTo } = require("../middleware/authMiddleware");

// ==========================================
// 🚨 ملاحظة هامة:
// تم نقل مسار الـ Webhook إلى ملف server.js الرئيسي
// لضمان عمله قبل express.json() وتجنب أخطاء التوقيع.
// ==========================================

// ==========================================
// 🌐 WEB ROUTES (Stripe Checkout)
// ==========================================

// 1. اشتراكات التجار (Web)
// متاح للتاجر (2) فقط
router.post(
  "/create-subscription-session",
  protect,
  restrictTo(2),
  createSubscriptionSession,
);

// 2. شراء منتجات للعملاء (Web)
// متاح للعميل (5) فقط
router.post(
  "/create-product-checkout",
  protect,
  restrictTo(5),
  createCheckoutSessionForProducts,
);

// 3. دفع رسوم الاتفاقيات (Web)
// التاجر (2) هو من يدفع للمودل/الانفلونسر
router.post(
  "/create-agreement-checkout-session",
  protect,
  restrictTo(2),
  createAgreementCheckoutSession,
);

// ==========================================
// 📱 MOBILE ROUTES (PaymentSheet / Native)
// ==========================================

// 4. شراء منتجات (Mobile App)
// متاح للعميل (5) فقط
router.post(
  "/mobile/create-payment-intent",
  protect,
  restrictTo(5),
  createMobilePaymentIntent,
);

// 5. اشتراكات (Mobile App - خطوة 1: SetupIntent)
// متاح للتاجر (2)
router.post(
  "/mobile/create-setup-intent",
  protect,
  restrictTo(2),
  createMobileSetupIntent,
);

// 6. اشتراكات (Mobile App - خطوة 2: Subscription)
// متاح للتاجر (2)
router.post(
  "/mobile/create-subscription",
  protect,
  restrictTo(2),
  createMobileSubscription,
);

// 7. دفع الاتفاقيات (Mobile App)
// متاح للتاجر (2)
router.post(
  "/mobile/create-agreement-intent",
  protect,
  restrictTo(2),
  createMobileAgreementIntent,
);

// 8. ترويج المنتجات (Mobile App)
// متاح للتاجر (2)
router.post(
  "/mobile/create-promotion-intent",
  protect,
  restrictTo(2),
  createMobilePromotionIntent,
);

// ==========================================
// 🛠 SHARED UTILITIES & MANAGEMENT
// ==========================================

// إلغاء الاشتراك (للتاجر 2)
router.post("/cancel-subscription", protect, restrictTo(2), cancelSubscription);

// إدارة البطاقات (متاح للكل من يدفع: التاجر 2 والعميل 5)
// يمكن إضافة أدوار أخرى هنا إذا لزم الأمر
router.get("/methods", protect, restrictTo(2, 5), getPaymentMethods);
router.delete("/methods/:id", protect, restrictTo(2, 5), deletePaymentMethod);
router.put(
  "/methods/:id/default",
  protect,
  restrictTo(2, 5),
  setDefaultPaymentMethod,
);

// Intent عام (للاختبار أو استخدامات أخرى)
router.post("/setup-intent", protect, createSetupIntent);
router.post("/create-intent", protect, createPaymentIntent);

// مسار قديم للاتفاقيات (احتياطي)
router.post(
  "/create-agreement-intent",
  protect,
  restrictTo(2),
  createAgreementPaymentIntent,
);

module.exports = router;
