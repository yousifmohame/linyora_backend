// backend/routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const {
  createCodOrder,
  createOrderFromIntent,
  updateOrderStatus,
} = require("../controllers/orderController");
const { protect } = require("../middleware/authMiddleware");

// ❌ تم حذف المسار "/" لأنه كان يستدعي دالة داخلية بشكل خاطئ

// إنشاء الطلبات
router.post("/create-cod", protect, createCodOrder);
router.post("/create-from-intent", protect, createOrderFromIntent);

// تحديث الحالة
router.put("/:id/status", protect, updateOrderStatus);

module.exports = router;