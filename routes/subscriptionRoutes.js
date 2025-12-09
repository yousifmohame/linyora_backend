// linora-platform/backend/routes/subscriptionRoutes.js

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getSubscriptionPlansForRole,
  createSubscriptionSession,
  getSubscriptionStatus,
  getSubscriptionHistory,
} = require("../controllers/subscriptionController");

router.get("/status", protect, getSubscriptionStatus);
router.get("/my-current", protect, getSubscriptionStatus);
router.get("/plans", protect, getSubscriptionPlansForRole);
router.post("/create-session", protect, createSubscriptionSession);
router.get('/history', protect, getSubscriptionHistory);

module.exports = router;
