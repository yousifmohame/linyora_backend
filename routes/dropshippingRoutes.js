const express = require("express");
const router = express.Router();

const {
  submitVerification,
  getDashboardData,
  getMerchantProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getOrders,
  getOrderDetails,
  updateOrderStatus,
  getSalesAnalytics,
  getStoreSettings,
  updateStoreSettings,
  getMerchantShippingCompanies,
  addMerchantShippingCompany,
  updateMerchantShippingCompany,
  deleteMerchantShippingCompany,
  getPromotionTiers,
  promoteProduct,
} = require("../controllers/merchantController");

const {
  getAvailableProducts,
  addProductToMerchantStore,
} = require("../controllers/dropshippingController");

const {
  protect,
  restrictTo,
  isVerifiedMerchant,
  requireSubscription,
} = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

// --- حماية جميع المسارات والتأكد من أن المستخدم هو "تاجر" ---
router.use(protect, restrictTo(2));

// --- مسارات لا تتطلب توثيقًا أو اشتراكًا ---
const cpUpload = upload.fields([
  { name: "identity_image", maxCount: 1 },
  { name: "business_license", maxCount: 1 },
  { name: "iban_certificate", maxCount: 1 },
]);
router.post("/verification", cpUpload, submitVerification);
router.get("/stats", getDashboardData);

// مسارات الطلبات
router.get("/orders", getOrders);
router.get("/orders/:id", getOrderDetails);
router.put("/orders/:id/status", updateOrderStatus);

// مسارات التحليلات والإعدادات
router.get("/analytics/sales", getSalesAnalytics);
router.route("/settings").get(getStoreSettings).put(updateStoreSettings);

// --- المسارات التالية تتطلب أن يكون التاجر موثقًا ومشتركًا ---
router.use(isVerifiedMerchant, requireSubscription);

// مسارات CRUD للمنتجات
router.route("/products").get(getMerchantProducts).post(createProduct);
router.route("/products/:id").put(updateProduct).delete(deleteProduct);

// مسارات إدارة الشحن
router
  .route("/shipping")
  .get(getMerchantShippingCompanies)
  .post(addMerchantShippingCompany);
router
  .route("/shipping/:id")
  .put(updateMerchantShippingCompany)
  .delete(deleteMerchantShippingCompany);

// مسارات ترويج المنتجات
router.get("/promotion-tiers", getPromotionTiers);
router.post("/products/:id/promote", promoteProduct);

router.use(protect, restrictTo(2), isVerifiedMerchant, requireSubscription);

// --- 3. Define the dropshipping routes ---
// Now that all security checks are applied above, these routes are fully protected.
router.get("/supplier-products", getAvailableProducts);
router.post("/import-product", addProductToMerchantStore);

module.exports = router;
