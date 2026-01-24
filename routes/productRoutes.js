// backend/routes/productRoutes.js
const express = require("express");
const router = express.Router();
const {
  getAllProducts,
  getProductById,
  getShippingOptionsForCart,
  getProductDetailsWithShipping,
  getPromotedProducts,
  getFilterOptions,
  searchProducts,
  getModelPromotableProducts,
} = require("../controllers/productController");

router.get('/search', searchProducts);

const { protect } = require("../middleware/authMiddleware");

router.get("/", getAllProducts);
router.get("/promoted", getPromotedProducts);
router.get("/model-promotable", protect, getModelPromotableProducts);
router.get("/filters", getFilterOptions);


router.get("/:id", getProductById);

// --- ✨ هذا هو الرابط الجديد والذكي ---
// سيستقبل قائمة بمنتجات السلة ويعيد شركات الشحن المتاحة لها
router.post("/shipping-options-for-cart", getShippingOptionsForCart);

// ✨ --- أضف هذا المسار الجديد --- ✨
// This route is public and provides all necessary details for the product page
router.get("/:id/details", getProductDetailsWithShipping);


module.exports = router;
