// routes/offerRoutes.js
const express = require('express');
const router = express.Router();
const { createPackage, getPackages, updatePackage, deletePackage } = require('../controllers/offerController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

// حماية جميع المسارات والتأكد من أن المستخدم هو عارضة أو مؤثرة
router.use(protect, restrictTo(3, 4));

router.route('/')
    .post(createPackage)
    .get(getPackages);


// --- ✨ المسارات الجديدة ---
router.route('/:id')
    .put(updatePackage)
    .delete(deletePackage);

module.exports = router;