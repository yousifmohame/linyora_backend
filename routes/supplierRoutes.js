const express = require("express");
const router = express.Router();
const { protect, isVerifiedSupplier } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

// Import all functions from the supplier controller
const {
  submitVerification,
  getSupplierDashboardStats,
  getSupplierProducts,
  createSupplierProduct,
  updateSupplierProduct,
  deleteSupplierProduct,
  getSupplierOrders,
  getSupplierOrderDetails,
  updateSupplierOrderStatus,
  getSupplierWallet,
  requestPayout,
  getMyShippingCompanies,
  addMyShippingCompany,
  updateMyShippingCompany,
  deleteMyShippingCompany,
  getSupplierSettings,
  updateSupplierSettings,
  getCategoriesForForm
} = require("../controllers/supplierController");

// --- Verification Route ---
// This route is for a supplier to submit their verification documents.
// It's protected but does NOT require the supplier to be verified yet.
router.post(
  "/verification",
  protect, // Must be logged in
  upload.fields([
    // Middleware to handle file uploads
    { name: "identity_image", maxCount: 1 },
    { name: "business_license", maxCount: 1 },
    { name: "iban_certificate", maxCount: 1 },
  ]),
  submitVerification
);

// --- Routes below this point require the supplier to be verified ---
router.use(protect, isVerifiedSupplier);

// --- Dashboard Route ---
// Gets statistics for the supplier's main dashboard page.
router.get("/dashboard", getSupplierDashboardStats);

// --- Product Management Routes ---
// Handles creating and listing products.
router.route("/products").get(getSupplierProducts).post(createSupplierProduct);

// Handles updating and deleting a specific product.
router
  .route("/products/:id")
  .put(updateSupplierProduct)
  .delete(deleteSupplierProduct);

router.get("/form-data/categories", getCategoriesForForm);

// --- Order Management Routes ---
// Gets a list of all orders that include this supplier's products.
router.get("/orders", protect, getSupplierOrders);

// Gets the full details for a single order, including customer shipping info.
router.get("/orders/:id", protect, getSupplierOrderDetails);

// Allows the supplier to update an order's status (e.g., to 'shipped').
router.put("/orders/:id/status", protect, updateSupplierOrderStatus);

router.get("/wallet", protect, getSupplierWallet);
router.post("/payout-request", protect, requestPayout);

// --- ✨ Add these new routes for Shipping --- ✨
router
  .route("/shipping")
  .get(protect, getMyShippingCompanies)
  .post(protect, addMyShippingCompany);

router
  .route("/shipping/:id")
  .put(protect, updateMyShippingCompany)
  .delete(protect, deleteMyShippingCompany);

router
  .route("/settings")
  .get(protect, getSupplierSettings)
  .put(protect, updateSupplierSettings);

module.exports = router;
