// backend/routes/categoryRoutes.js
const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware'); // <-- 1. استيراد middleware الرفع

// Public route to get all categories
router.get('/', categoryController.getAllCategories);

// Admin routes for managing categories
router.post('/', protect, upload.single('image'), categoryController.createCategory); // <-- 2. إضافة middleware هنا
router.put('/:id', protect, upload.single('image'), categoryController.updateCategory); // <-- 3. إضافة middleware هنا
router.delete('/:id', protect, categoryController.deleteCategory);

router.get('/:slug/products', categoryController.getProductsByCategorySlugd);


module.exports = router;