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
} = require("../controllers/productController");

router.get("/", getAllProducts);
router.get("/promoted", getPromotedProducts);
router.get("/filters", getFilterOptions);
router.get('/search', searchProducts);

router.get("/:id", getProductById);

// --- ✨ هذا هو الرابط الجديد والذكي ---
// سيستقبل قائمة بمنتجات السلة ويعيد شركات الشحن المتاحة لها
router.post("/shipping-options-for-cart", getShippingOptionsForCart);

// ✨ --- أضف هذا المسار الجديد --- ✨
// This route is public and provides all necessary details for the product page
router.get("/:id/details", getProductDetailsWithShipping);


module.exports = router;
