// backend/routes/settingsRoutes.js
const express = require("express");
const router = express.Router();
const { getSetting, updateSetting } = require("../controllers/settingsController");
const { protect, restrictTo } = require("../middleware/authMiddleware"); //

// --- Public Route ---
// (أي شخص يمكنه قراءة الإعدادات)
router.get("/:key", getSetting);

// --- Admin Route ---
// (فقط الأدمن يمكنه التعديل)
router.put("/:key", protect, restrictTo(1), updateSetting); // (نفترض أن 1 هو ID الأدمن)

module.exports = router;