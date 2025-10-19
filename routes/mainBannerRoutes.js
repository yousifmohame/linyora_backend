const express = require('express');
const router = express.Router();
const { 
    getAllBanners, 
    createBanner, 
    updateBanner, 
    deleteBanner 
} = require('../controllers/mainBannerController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const upload = require('../middleware/uploadMiddleware'); // ✅ Import upload middleware

router.use(protect, restrictTo(1)); // Admin only

router.route('/')
    .get(getAllBanners)
    // ✅ Apply middleware to handle single image upload on the 'image' field
    .post(upload.single('image'), createBanner);

router.route('/:id')
    // ✅ Apply middleware for updates as well
    .put(upload.single('image'), updateBanner)
    .delete(deleteBanner);

module.exports = router;