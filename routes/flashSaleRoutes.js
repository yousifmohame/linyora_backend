// routes/browseRoutes.js
const express = require("express");
const router = express.Router();
const {
  getActiveFlashSale,
  getMerchantCampaigns,
  respondToCampaign,
} = require("../controllers/flashSaleController");

const { protect } = require("../middleware/authMiddleware");

router.get("/active", getActiveFlashSale);

router.get("/merchant", protect, getMerchantCampaigns);

// 2. الرد على الدعوة (قبول/رفض)
router.put("/merchant/:id/respond", protect, respondToCampaign);

module.exports = router;
