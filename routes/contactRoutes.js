// linora-platform/backend/routes/contactRoutes.js

const express = require('express');
const router = express.Router();
const { sendContactMessage } = require('../controllers/contactController');

router.post('/', sendContactMessage);

module.exports = router;