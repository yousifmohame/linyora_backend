const express = require("express");
const router = express.Router();
const {
    getContentByKey,
    getAllContent,
    updateContent,
} = require("../controllers/contentController");
const { protect } = require("../middleware/authMiddleware"); // سنحتاج لتعديل هذا لاحقًا

router.route("/").get(protect, getAllContent); // للمشرف فقط
router.route("/:key").get(getContentByKey).put(protect, updateContent); // جلب للعامة، تحديث للمشرف

module.exports = router;