// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const upload = require("../middleware/uploadMiddleware");

// --- Controllers Imports ---
const {
  getAllUsers,
  updateUser,
  deleteUser,
  getAllAgreements,
  updateAgreementStatus,
  getPlatformStats,
  getSettings,
  updateSettings,
  getShippingCompanies,
  addShippingCompany,
  updateShippingCompany,
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
  getModelPayoutDetails,
  createSubAdmin,
  getSubAdmins,
  updateSubAdmin,
  updateOrderStatus,
} = require("../controllers/adminController");

const storyController = require("../controllers/storyController");
const sectionController = require("../controllers/sectionController");
const { getSetting, updateSetting } = require("../controllers/settingsController");

const {
  updateCategory,
  createCategory,
  deleteCategory,
  getAllCategories,
} = require("../controllers/categoryController");

const {
  getAllBanners,
  createBanner,
  updateBanner,
  deleteBanner,
} = require("../controllers/mainBannerController");

const {
  getMarqueeMessages,
  getActiveMarqueeMessages,
  createMarqueeMessage,
  updateMarqueeMessage,
  deleteMarqueeMessage,
} = require("../controllers/marqueeController");

const {
  getContentByKey,
  getAllContent,
  updateContent,
} = require("../controllers/contentController");

const {
  createFlashSale,
  getAllFlashSales
} = require("../controllers/flashSaleController");

const {
  protect,
  restrictTo,
  checkPermission,
} = require("../middleware/authMiddleware");

// =================================================================
// 🔒 GLOBAL PROTECTION
// =================================================================
// Protect all routes: User must be logged in & Role ID must be 1 (Admin)
router.use(protect, restrictTo(1));


// =================================================================
// 🛠️ SUB-ADMIN MANAGEMENT
// =================================================================
router.post("/sub-admins", checkPermission("settings", "write"), createSubAdmin);
router.get("/sub-admins", checkPermission("settings", "read"), getSubAdmins);
router.put("/sub-admins/:id", checkPermission("settings", "write"), updateSubAdmin);


// =================================================================
// 👥 USER MANAGEMENT
// =================================================================
router.route("/users")
  .get(checkPermission("users", "read"), getAllUsers);

router.route("/users/:id")
  .put(checkPermission("users", "write"), updateUser)
  .delete(checkPermission("users", "write"), deleteUser);


// =================================================================
// 📜 AGREEMENTS
// =================================================================
router.get("/agreements", checkPermission("agreements", "read"), getAllAgreements);
router.put("/agreements/:id", checkPermission("agreements", "write"), updateAgreementStatus);


// =================================================================
// 📊 STATS & ANALYTICS
// =================================================================
router.get("/stats", checkPermission("settings", "read"), getPlatformStats);
router.get("/dashboard-analytics", checkPermission("settings", "read"), getDashboardAnalytics);


// =================================================================
// ⚙️ SETTINGS
// =================================================================
router.route("/settings")
  .get(checkPermission("settings", "read"), getSettings)
  .put(checkPermission("settings", "write"), updateSettings);


// =================================================================
// 🚚 SHIPPING
// =================================================================
router.route("/shipping")
  .get(checkPermission("shipping", "read"), getShippingCompanies)
  .post(checkPermission("shipping", "write"), addShippingCompany);

router.put("/shipping/:id", checkPermission("shipping", "write"), updateShippingCompany);


// =================================================================
// 💎 SUBSCRIPTIONS (USER & PLANS)
// =================================================================
// User Subscriptions
router.get("/subscriptions", checkPermission("subscriptions", "read"), getAllSubscriptions);
router.post("/subscriptions/:id/cancel", checkPermission("subscriptions", "write"), cancelUserSubscription);
router.delete("/subscriptions/:id", checkPermission("subscriptions", "write"), deleteUserSubscription);

// Subscription Plans
router.route("/subscription-plans")
  .get(checkPermission("Manage-Subscriptions", "read"), getSubscriptionPlans)
  .post(checkPermission("Manage-Subscriptions", "write"), createSubscriptionPlan);

router.route("/subscription-plans/:id")
  .put(checkPermission("Manage-Subscriptions", "write"), updateSubscriptionPlan);


// =================================================================
// 📦 PRODUCTS
// =================================================================
router.get("/products", checkPermission("products", "read"), getAllProducts);
router.put("/products/:id", checkPermission("products", "write"), updateProductStatusByAdmin);
router.delete("/products/:id", checkPermission("products", "write"), deleteProductByAdmin);


// =================================================================
// 🛒 ORDERS
// =================================================================
router.get("/orders", checkPermission("orders", "read"), getAllPlatformOrders);
router.get("/orders/:id", checkPermission("orders", "read"), getOrderDetails);
router.put("/orders/:id/status", checkPermission("orders", "write"), updateOrderStatus);

// =================================================================
// ✅ VERIFICATIONS
// =================================================================
router.get("/verifications", checkPermission("verification", "read"), getPendingVerifications);
router.get("/verifications/:id", checkPermission("verification", "read"), getVerificationDetails);
router.put("/verifications/:id", checkPermission("verification", "write"), reviewVerification);


// =================================================================
// 💰 PAYOUTS & FINANCE
// =================================================================
// General Payouts
router.get("/payouts", checkPermission("payouts", "read"), getAllPayoutRequests);
router.get("/payouts/:id", checkPermission("payouts", "read"), getPayoutRequestDetails);
router.put("/payouts/:id", checkPermission("payouts", "write"), updatePayoutRequestStatus);

// Model Payouts
router.route("/model-payouts")
  .get(checkPermission("model payouts", "read"), getAllModelPayouts);

router.route("/model-payouts/:id")
  .get(checkPermission("model payouts", "read"), getModelPayoutDetails)
  .put(checkPermission("model payouts", "write"), updateModelPayoutStatus);


// =================================================================
// 📢 PROMOTIONS
// =================================================================
router.route("/promotion-tiers")
  .get(checkPermission("Promotions", "read"), getAllPromotionTiers)
  .post(checkPermission("Promotions", "write"), createPromotionTier);

router.route("/promotion-tiers/:id")
  .put(checkPermission("Promotions", "write"), updatePromotionTier);

router.get("/promotion-requests", checkPermission("Promotions", "read"), getPromotionRequests);
router.put("/promotion-requests/:id/approve", checkPermission("Promotions", "write"), approvePromotionRequest);


// =================================================================
// 💬 MESSAGES
// =================================================================
router.get("/conversations", checkPermission("messages", "read"), adminGetAllConversations);
router.get("/conversations/:conversationId", checkPermission("messages", "read"), adminGetMessagesForConversation);


// =================================================================
// 📸 STORIES
// =================================================================
// My Stories Management
router.post("/my-stories", upload.single("media"), checkPermission("stories", "write"), storyController.createStory);
router.get("/my-stories", checkPermission("stories", "read"), storyController.getMyStories);
router.delete("/my-stories/:id", checkPermission("stories", "write"), storyController.deleteStory);
router.post("/my-stories/view", checkPermission("stories", "read"), storyController.markStorySeen);

// Story Sections (Old Routes - Keeping for compatibility if needed, but consider merging with Sections below)
router.get("/my-stories/sections", checkPermission("stories", "read"), storyController.getSections);
router.post("/my-stories/sections", upload.single("cover_image"), checkPermission("stories", "write"), storyController.createSection);
router.delete("/my-stories/sections/:id", checkPermission("stories", "write"), storyController.deleteSection);


// =================================================================
// 🖼️ MAIN BANNERS
// =================================================================
router.route("/main-banners")
  .get(checkPermission("main-banners", "read"), getAllBanners)
  .post(checkPermission("main-banners", "write"), upload.single("image"), createBanner);

router.route("/main-banners/:id")
  .put(checkPermission("main-banners", "write"), upload.single("image"), updateBanner)
  .delete(checkPermission("main-banners", "write"), deleteBanner);


// =================================================================
// 🥖 MARQUEE BAR
// =================================================================
router.route("/marquee")
  .get(checkPermission("marquee-bar", "read"), getMarqueeMessages)
  .post(checkPermission("marquee-bar", "write"), createMarqueeMessage);

router.route("/marquee/:id")
  .put(checkPermission("marquee-bar", "write"), updateMarqueeMessage)
  .delete(checkPermission("marquee-bar", "write"), deleteMarqueeMessage);

// Marquee Specific Settings
router.get("/marquee/settings/:key", checkPermission("marquee-bar", "read"), getSetting);
router.put("/marquee/settings/:key", checkPermission("marquee-bar", "write"), updateSetting);


// =================================================================
// 📂 CATEGORIES
// =================================================================
router.get('/categories', checkPermission("categories", "read"), getAllCategories);
router.post('/categories', upload.single('image'), checkPermission("categories", "write"), createCategory);
router.put('/categories/:id', upload.single('image'), checkPermission("categories", "write"), updateCategory);
router.delete('/categories/:id', checkPermission("categories", "write"), deleteCategory);


// =================================================================
// 🧩 SECTIONS (Global Layout Sections)
// =================================================================
router.get('/sections/admin/all', checkPermission("sections", "read"), sectionController.getAllSectionsAdmin);
router.post('/sections', checkPermission("sections", "write"), sectionController.createSection);
router.put('/sections/:id', checkPermission("sections", "write"), sectionController.updateSection);
router.delete('/sections/:id', checkPermission("sections", "write"), sectionController.deleteSection);


router.get('/flash-sales', checkPermission('settings', 'read'), getAllFlashSales);
router.post('/flash-sale', checkPermission('settings', 'write'), createFlashSale);

// =================================================================
// 📝 CONTENT (Pages like About Us, Terms)
// =================================================================
router.route("/content")
  .get(checkPermission("Content", "read"), getAllContent);

router.route("/content/:key")
  .get(checkPermission("Content", "read"), getContentByKey)
  .put(checkPermission("Content", "write"), updateContent);


// =================================================================
// 🌐 PUBLIC ROUTES (Exceptions that might be needed)
// =================================================================
// Note: Usually public routes should be in a separate file or before the router.use(protect)
// But if you keep it here, ensure `protect` allows it or move it to marqueeRoutes.js
router.get("/active", getActiveMarqueeMessages); 


module.exports = router;