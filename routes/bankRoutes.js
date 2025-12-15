const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const bankController = require('../controllers/bankController');

router.get('/details', protect, bankController.getBankDetails);
router.post('/details', protect, bankController.updateBankDetails);

module.exports = router;