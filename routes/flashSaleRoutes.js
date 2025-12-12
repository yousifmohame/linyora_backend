// routes/browseRoutes.js
const express = require("express");
const router = express.Router();
const {
  getActiveFlashSale,
  
} = require("../controllers/flashSaleController");

router.get('/active', getActiveFlashSale);


module.exports = router;
