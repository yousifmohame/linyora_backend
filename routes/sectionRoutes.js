const express = require('express');
const router = express.Router();
const sectionController = require('../controllers/sectionController');
const { protect } = require('../middleware/authMiddleware'); // افتراض وجود middleware للحماية

// Public
router.get('/active', sectionController.getActiveSections);
router.get('/:id', sectionController.getSectionById);
// Admin Only
router.get('/admin/all', protect, sectionController.getAllSectionsAdmin);
router.post('/', protect, sectionController.createSection);
router.put('/:id', protect, sectionController.updateSection);
router.delete('/:id', protect, sectionController.deleteSection);

module.exports = router;