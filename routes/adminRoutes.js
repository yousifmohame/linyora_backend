// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  updateUser,
  deleteUser,
  getAllAgreements,
  updateAgreementStatus,
  getPlatformStats,
  getSettings,
  updateSettings,
  getShippingCompanies, // ✨ جديد
  addShippingCompany, // ✨ جديد
  updateShippingCompany, // ✨ جديد
  getAllSubscriptions,
  cancelUserSubscription,
  deleteUserSubscription,
  getAllProducts,
  updateProductStatusByAdmin,
  deleteProductByAdmin,
  getAllPlatformOrders,
  getOrderDetails,
  getDashboardAnalytics,
  getPendingVerifications,
  getVerificationDetails,
  reviewVerification,
  getAllPayoutRequests,
  updatePayoutRequestStatus,
  getPayoutRequestDetails,
  getAllPromotionTiers,
  createPromotionTier,
  updatePromotionTier,
  getPromotionRequests,
  approvePromotionRequest,
  getSubscriptionPlans,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  getAllModelPayouts,
  updateModelPayoutStatus,
  adminGetAllConversations,
  adminGetMessagesForConversation,
} = require("../controllers/adminController");
const {
  updateCategory,
  createCategory,
  deleteCategory,
} = require("../controllers/categoryController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

// حماية جميع المسارات في هذا الملف والتأكد من أن المستخدم هو مشرف
router.use(protect, restrictTo(1));

// GET /api/admin/users
router.route("/users").get(getAllUsers);

router.route("/users/:id").put(updateUser).delete(deleteUser);

// --- ✨ المسار الجديد ---
// GET /api/admin/agreements
router.get("/agreements", getAllAgreements);
router.put("/agreements/:id", updateAgreementStatus);

// --- ✨ المسار الجديد ---
// GET /api/admin/stats
router.get("/stats", getPlatformStats);

// --- ✨ مسارات الإعدادات ---
router.route("/settings").get(getSettings).put(updateSettings);

router.route("/shipping").get(getShippingCompanies).post(addShippingCompany);
router.put("/shipping/:id", updateShippingCompany);

// --- ✨ New Subscription Management Routes for Admin ---
router.get("/subscriptions", getAllSubscriptions);
router.post("/subscriptions/:id/cancel", cancelUserSubscription);
router.delete("/subscriptions/:id", deleteUserSubscription);

// --- ✨ تحديث مسارات المنتجات للمشرفة ---
// --- ✨ مسارات إدارة المنتجات الخاصة بالمسؤول (الجديدة) ---
router.get("/products", getAllProducts);
router.put("/products/:id", updateProductStatusByAdmin);
router.delete("/products/:id", deleteProductByAdmin);

// --- ✨ مسارات إدارة الطلبات الخاصة بالمسؤول (الجديدة) ---
router.get("/orders", getAllPlatformOrders);
router.get("/orders/:id", getOrderDetails);
router.get("/dashboard-analytics", getDashboardAnalytics);

router.get("/verifications", getPendingVerifications);
router.get("/verifications/:id", getVerificationDetails);
router.put("/verifications/:id", reviewVerification);

// --- Payout Management Routes ---
router.get("/payouts", protect, getAllPayoutRequests);
router.put("/payouts/:id", protect, updatePayoutRequestStatus);
router.get("/payouts/:id", protect, getPayoutRequestDetails); // <-- ✨ أضف هذا المسار الجديد

// --- ✨ مسارات إدارة ترويج المنتجات ✨ ---
router
  .route("/promotion-tiers")
  .get(getAllPromotionTiers)
  .post(createPromotionTier);

router.route("/promotion-tiers/:id").put(updatePromotionTier);

router.get("/promotion-requests", getPromotionRequests);
router.put("/promotion-requests/:id/approve", approvePromotionRequest);
// Subscription Plans Management
router
  .route("/subscription-plans")
  .get(protect, getSubscriptionPlans)
  .post(protect, createSubscriptionPlan);

router.route("/subscription-plans/:id").put(protect, updateSubscriptionPlan);

// --- ✨ Payout Management Routes for Models (New) ---
router.route("/model-payouts").get(getAllModelPayouts);
router.route("/model-payouts/:id").put(updateModelPayoutStatus);

router.get("/conversations", protect, adminGetAllConversations);
router.get(
  "/conversations/:conversationId",
  protect,
  adminGetMessagesForConversation
);

// --- ✨ مسارات إدارة الفئات الخاصة بالمسؤول ✨ ---
router.route("/categories").post(createCategory);

router.route("/categories/:id").put(updateCategory).delete(deleteCategory);

module.exports = router;
