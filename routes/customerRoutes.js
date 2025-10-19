// backend/routes/customerRoutes.js
const express = require("express");
const router = express.Router();
const {
  getCustomerOrders,
  getCustomerOrderDetails,
  addProductReview,
  updateProfile,
  getWishlist, // ✨ جديد
  addToWishlist, // ✨ جديد
  removeFromWishlist,
  checkWishlistStatus,
  getDashboardStats,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
} = require("../controllers/customerController");
const { protect, restrictTo } = require("../middleware/authMiddleware");

router.use(protect, restrictTo(5));

// مسارات الطلبات والملف الشخصي
router.get("/orders", getCustomerOrders);
router.get("/orders/:orderId", protect, getCustomerOrderDetails);
router.post("/reviews", addProductReview);
router.put("/profile", updateProfile);

// Address Management Routes
router.route("/addresses").get(getAddresses).post(addAddress);

router.route("/addresses/:id").put(updateAddress).delete(deleteAddress);

// --- ✨ مسارات قائمة الأمنيات الجديدة ---
router.get("/wishlist", getWishlist);
router.post("/wishlist", addToWishlist);
router.delete("/wishlist/:productId", removeFromWishlist);
router.post("/wishlist/status", checkWishlistStatus);

router.get("/dashboard", getDashboardStats);

module.exports = router;
