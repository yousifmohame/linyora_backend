// backend/routes/marqueeRoutes.js
const express = require("express");
const router = express.Router();
const {
  getMarqueeMessages,
  getActiveMarqueeMessages,
  createMarqueeMessage,
  updateMarqueeMessage,
  deleteMarqueeMessage,
} = require("../controllers/marqueeController");

const { protect, restrictTo } = require("../middleware/authMiddleware"); //
const adminOnly = [protect, restrictTo(1)]; // (نفترض أن 1 هو ID الادمن)

// --- Public Route ---
router.get("/active", getActiveMarqueeMessages);

// --- Admin Routes ---
router.route("/")
  .get(adminOnly, getMarqueeMessages)
  .post(adminOnly, createMarqueeMessage);

router.route("/:id")
  .put(adminOnly, updateMarqueeMessage)
  .delete(adminOnly, deleteMarqueeMessage);

module.exports = router;