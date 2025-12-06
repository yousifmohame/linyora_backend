// backend/routes/merchantRoutes.js
const express = require("express");
const router = express.Router();

// --- 1. استيراد الدوال الموحدة والصحيحة ---
const {
    submitVerification,
    getDashboardData,
    getMerchantProducts, // تم التغيير من getProducts
    createProduct,
    updateProduct,
    deleteProduct,
    getOrders,
    getOrderDetails,
    updateOrderStatus,
    getSalesAnalytics,
    getStoreSettings,
    updateStoreSettings,
    getSubscriptionDetails,
    getMerchantShippingCompanies,
    addMerchantShippingCompany,
    updateMerchantShippingCompany,
    deleteMerchantShippingCompany,
    getPromotionTiers, // تم التغيير
    promoteProduct,      // تم التغيير
    getMerchantPublicProfile
} = require("../controllers/merchantController");

const {
    protect,
    restrictTo,
    isVerifiedMerchant,
    optionalProtect,
} = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");


router.get('/public-profile/:id', optionalProtect, getMerchantPublicProfile);
// --- 2. حماية جميع المسارات والتأكد من أن المستخدم هو "تاجر" ---
router.use(protect, restrictTo(2));

// --- 3. مسارات لا تتطلب توثيقًا ---
const cpUpload = upload.fields([
    { name: "identity_image", maxCount: 1 },
    { name: "business_license", maxCount: 1 },
    { name: "iban_certificate", maxCount: 1 },
]);
router.post("/verification", cpUpload, submitVerification);
router.get("/stats", getDashboardData); // لوحة التحكم الأساسية

// --- 4. المسارات التالية تتطلب أن يكون التاجر موثقًا ---
router.use(isVerifiedMerchant);

// مسارات CRUD للمنتجات (استخدام الدالة المحدثة)
router.route("/products").get(getMerchantProducts).post(createProduct);
router.route("/products/:id").put(updateProduct).delete(deleteProduct);

// مسارات الطلبات
router.get("/orders", getOrders);
router.get("/orders/:id", getOrderDetails);
router.put("/orders/:id/status", updateOrderStatus);

// مسارات التحليلات والإعدادات
router.get("/analytics/sales", getSalesAnalytics);
router.get("/subscription", getSubscriptionDetails);
router.route("/settings").get(getStoreSettings).put(updateStoreSettings);

// مسارات إدارة الشحن
router.route("/shipping")
    .get(getMerchantShippingCompanies)
    .post(addMerchantShippingCompany);

router.route("/shipping/:id")
    .put(updateMerchantShippingCompany)
    .delete(deleteMerchantShippingCompany);

// --- 5. مسارات ترويج المنتجات (النسخة الموحدة) ---
router.get('/promotion-tiers', getPromotionTiers);
// تم توحيد اسم المعلمة إلى :id لتكون متسقة
router.post('/products/:id/promote', promoteProduct);

module.exports = router;