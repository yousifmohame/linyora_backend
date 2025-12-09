const express = require("express");
const router = express.Router();
const {
  createOrderInternal,
  createCodOrder,
  updateOrderStatus,
  createOrderFromIntent,
} = require("../controllers/orderController");
const { protect } = require("../middleware/authMiddleware");

// POST /api/orders
router.post("/", protect, createOrderInternal);

router.post("/create-cod", protect, createCodOrder);
router.post("/create-from-intent", protect, createOrderFromIntent);
router.put("/:id/status", protect, updateOrderStatus);

module.exports = router;
