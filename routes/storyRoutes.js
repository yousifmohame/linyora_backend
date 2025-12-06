const express = require("express");
const router = express.Router();
const { protect, optionalProtect } = require("../middleware/authMiddleware"); 
const upload = require("../middleware/uploadMiddleware");
const storyController = require("../controllers/storyController");

// --- المسارات العامة (Public/Shared) ---
router.get("/feed", optionalProtect, storyController.getStoriesFeed);
router.get("/:id/view", optionalProtect, storyController.getStoriesById);

// --- مسارات تتطلب تسجيل دخول (Protected) ---
router.use(protect);

// القصص
router.post("/", upload.single('media'), storyController.createStory);
router.get("/my-stories", storyController.getMyStories); // <--- المسار المفقود 1
router.delete("/:id", storyController.deleteStory);      // <--- مسار الحذف
router.post("/view", storyController.markStorySeen);

// --- مسارات الأقسام (Sections) ---
// ملاحظة: الترتيب مهم، ضع المسارات الثابتة مثل /sections قبل المتغيرة مثل /:id
router.get("/sections", storyController.getSections);           // <--- المسار المفقود 2
router.post("/sections", upload.single('cover_image'), storyController.createSection);
router.delete("/sections/:id", storyController.deleteSection); // <--- مسار حذف القسم

module.exports = router;