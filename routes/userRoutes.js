// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");
const {
  getUserProfile,
  updateUserProfile,
  getUserAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  acceptAgreement,
  submitVerification,
  updateProfilePicture,
} = require("../controllers/userController"); // ✨ استيراد الدوال الجديدة

// GET /api/users/profile -> لجلب بيانات المستخدم الحالي
// PUT /api/users/profile -> لتحديث بيانات المستخدم الحالي
router
  .route("/profile")
  .get(protect, getUserProfile)
  .put(protect, updateUserProfile);

router.route("/profile/accept-agreement").put(protect, acceptAgreement);

router
  .route("/addresses")
  .get(protect, getUserAddresses)
  .post(protect, addAddress);

router
  .route("/addresses/:id")
  .put(protect, updateAddress)
  .delete(protect, deleteAddress);

router.put("/addresses/:id/default", protect, setDefaultAddress);

router.post(
  "/submit-verification",
  protect,
  upload.single("identity_image"),
  submitVerification
);

router
  .route("/profile/picture")
  .post(protect, upload.single("profilePicture"), updateProfilePicture);

module.exports = router;
