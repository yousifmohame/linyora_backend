// backend/routes/modelRoutes.js
const express = require("express");
const router = express.Router();
const {
  getMyProfile,
  updateMyProfile,
  getDashboardStats,
  getAnalytics,
  getRecentActivity,
} = require("../controllers/modelController");
const { protect, restrictTo, verifyProfile } = require("../middleware/authMiddleware");

// حماية جميع المسارات والتأكد من أن المستخدم هو مودل أو مؤثرة
router.use(protect, restrictTo(3, 4));

router.get("/dashboard", getDashboardStats);
router.get("/recent-activity", getRecentActivity);
router.get("/analytics", getAnalytics);

router.use(protect, restrictTo(3, 4), verifyProfile);

router.route("/profile").get(getMyProfile).put(updateMyProfile);


module.exports = router;
