// backend/routes/walletRoutes.js
const express = require("express");
const router = express.Router();
const {
  getMyWallet,
  requestPayout,
  getWalletTransactions,
} = require("../controllers/walletController"); // 👈 استيراد الدوال الموحدة الجديدة

const { protect } = require("../middleware/authMiddleware");

// ==================================================================
// 💰 Unified Wallet Routes (نظام المحفظة الموحد)
// يخدم التاجر، المورد، والمودل بنفس الكفاءة
// ==================================================================

// 1. عرض الرصيد والإحصائيات
router.get("/my-wallet", protect, getMyWallet);

// 2. سجل المعاملات (مع دعم الفلترة والبحث)
router.get("/transactions", protect, getWalletTransactions);

// 3. طلب سحب الأرباح
router.post("/request-payout", protect, requestPayout);

module.exports = router;