// routes/userRoutes.js
const express = require("express");
const router = express.Router();
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
  getUserPublicProfile,
  followUser,
  unfollowUser,
} = require("../controllers/userController"); // ✨ استيراد الدوال الجديدة
const { protect , optionalProtect} = require("../middleware/authMiddleware");

// GET /api/users/profile -> لجلب بيانات المستخدم الحالي
// PUT /api/users/profile -> لتحديث بيانات المستخدم الحالي
router
  .route("/profile")
  .get(protect, getUserProfile)
  .put(protect, updateUserProfile);

router.route("/profile/accept-agreement").put(protect, acceptAgreement);

router.get('/:id/profile', optionalProtect, getUserPublicProfile);

router.route("/:id/follow")
  .post(protect, followUser)     // للمتابعة
  .delete(protect, unfollowUser); // لإلغاء المتابعة

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
