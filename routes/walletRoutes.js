// backend/routes/walletRoutes.js
const express = require("express");
const router = express.Router();
const {
  getMerchantWallet,
  requestPayout,
  getWalletTransactions,
  getModelWallet,
  getModelTransactions,
  getsupplierTransactions,
  requestModelPayout,
} = require("../controllers/walletController");
const {
  protect,
  isVerifiedMerchant,
  restrictTo,
} = require("../middleware/authMiddleware");

router.get("/my-wallet", protect, isVerifiedMerchant, getMerchantWallet);
router.post("/request-payout", protect, isVerifiedMerchant, requestPayout);

// --- ✅ This is the new route for transaction history ---
router.get("/transactions", protect, isVerifiedMerchant, getWalletTransactions);

// --- ✨ Model/Influencer Wallet Routes (محدثة بالكامل) ---
router.get("/model/my-wallet", protect, restrictTo(3, 4), getModelWallet);
router.get(
  "/model/transactions",
  protect,
  restrictTo(3, 4),
  getModelTransactions
); // ✨ المسار الجديد

router.get(
  "/supplier/transactions",
  protect,
  getsupplierTransactions
); // ✨ المسار الجديد


router.post(
  "/model/request-payout",
  protect,
  restrictTo(3, 4),
  requestModelPayout
);

module.exports = router;
