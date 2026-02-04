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
} = require("../controllers/browseController");
const { protect, restrictTo, optionalProtect } = require("../middleware/authMiddleware");
const { getActiveBanners } = require("../controllers/mainBannerController"); // استيراد الدالة الجديدة
const { getAllCategories } = require("../controllers/categoryController"); // ✅ أضف هذا السطر

// هذه المسارات متاحة فقط للتجار المسجلين (roleId = 2)
router.get("/trends", getPromotedProducts);
router.get("/all-products", getAllProductsForTagging);
router.get("/main-banners", getActiveBanners);
router.get('/homepage/layout', getHomeLayout);
router.get("/categories", getAllCategories);
router.route("/new-arrivals").get(getNewArrivals);
router.route("/best-sellers").get(getBestSellers);
router.route("/top-rated").get(getTopRated);
router.get("/trends", getTrendingProducts);
router.get("/models/:id", getPublicModelProfile);
router.get("/categories/:slug", getProductsByCategorySlug);
router.get("/top-models", optionalProtect, getTopModels);
router.get("/top-merchants", optionalProtect, getTopMerchants);

router.use(protect, restrictTo(2));

router.get("/models", getAllModels);
router.get("/promoted-products", getPromotedProducts);

module.exports = router;
