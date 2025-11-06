const express = require('express');
const router = express.Router();
const { createOrderInternal, createCodOrder, updateOrderStatus } = require('../controllers/orderController');
const { protect } = require('../middleware/authMiddleware');

// POST /api/orders
router.post('/', protect, createOrderInternal);

router.post('/create-cod', protect, createCodOrder);
router.put('/:id/status', protect, updateOrderStatus);

module.exports = router;