// routes/browseRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllModels,
  getPublicModelProfile,
  getPromotedProducts,
  getProductsByCategorySlug,
  getTrendingProducts,
  getAllProductsForTagging,
  getNewArrivals,
  getBestSellers,
  getTopRated,
  getTopModels,
  getTopMerchants,
  getHomeLayout,
  updateHomeLayout, // ✅ 1. تمت إضافة دالة التحديث هنا
} = require("../controllers/browseController");

const { protect, restrictTo, optionalProtect } = require("../middleware/authMiddleware");
const { getActiveBanners } = require("../controllers/mainBannerController");
const { getAllCategories } = require("../controllers/categoryController");

// --- المسارات العامة (Public Routes) ---

// جلب الترتيب (متاح للجميع)
router.get('/homepage/layout', getHomeLayout);

// ✅ 2. حفظ الترتيب (للأدمن فقط)
// هذا هو الرابط الذي يطلبه زر الحفظ في الفرونت إند
router.post(
  '/homepage/layout', 
  protect,        // يجب أن يكون مسجلاً للدخول
  restrictTo(1),  // يجب أن يكون أدمن (Role ID = 1)
  updateHomeLayout
);

router.get("/trends", getPromotedProducts);
router.get("/all-products", getAllProductsForTagging);
router.get("/main-banners", getActiveBanners);
router.get("/categories", getAllCategories);
router.route("/new-arrivals").get(getNewArrivals);
router.route("/best-sellers").get(getBestSellers);
router.route("/top-rated").get(getTopRated);
router.get("/trends", getTrendingProducts);
router.get("/models/:id", getPublicModelProfile);
router.get("/categories/:slug", getProductsByCategorySlug);
router.get("/top-models", optionalProtect, getTopModels);
router.get("/top-merchants", optionalProtect, getTopMerchants);

// --- المسارات المحمية (تجار ومودلز) ---
router.use(protect, restrictTo(2));

router.get("/models", getAllModels);
router.get("/promoted-products", getPromotedProducts);

module.exports = router;
