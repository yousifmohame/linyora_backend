// routes/browseRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllModels,
  getPublicModelProfile,
  getPromotedProducts,
  getProductsByCategorySlug,
} = require("../controllers/browseController");
const { protect, restrictTo } = require("../middleware/authMiddleware");
const { getActiveBanners } = require("../controllers/mainBannerController"); // استيراد الدالة الجديدة
const { getAllCategories } = require("../controllers/categoryController"); // ✅ أضف هذا السطر

// هذه المسارات متاحة فقط للتجار المسجلين (roleId = 2)
router.get("/trends", getPromotedProducts);
router.get("/main-banners", getActiveBanners);
router.get("/categories", getAllCategories);
router.get("/categories/:slug", getProductsByCategorySlug);

router.use(protect, restrictTo(2));

router.get("/models", getAllModels);
router.get("/models/:id", getPublicModelProfile);
router.get("/promoted-products", getPromotedProducts);

module.exports = router;
