const pool = require('../config/db');
const asyncHandler = require('express-async-handler');

// @desc    Admin: Get all main banners
// @route   GET /api/main-banners
// @access  Admin
exports.getAllBanners = asyncHandler(async (req, res) => {
    const [banners] = await pool.query("SELECT * FROM main_banners ORDER BY created_at DESC");
    res.status(200).json(banners);
});

// @desc    Admin: Create a new main banner
// @route   POST /api/main-banners
// @access  Admin
exports.createBanner = asyncHandler(async (req, res) => {
    const { title, subtitle, link_url, button_text, badge_text, is_active } = req.body;
    
    // ✅ Get the image URL from the upload middleware (req.file)
    const image_url = req.file ? req.file.path : null;

    if (!image_url) {
        return res.status(400).json({ message: 'Image is required.' });
    }

    const [result] = await pool.query(
        "INSERT INTO main_banners (title, subtitle, image_url, link_url, button_text, badge_text, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [title, subtitle, image_url, link_url, button_text, badge_text, is_active === 'true']
    );
    res.status(201).json({ id: result.insertId, image_url, ...req.body });
});

// @desc    Admin: Update a main banner
// @route   PUT /api/main-banners/:id
// @access  Admin
exports.updateBanner = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, subtitle, link_url, button_text, badge_text, is_active } = req.body;

    // ✅ Get the new image URL if one was uploaded
    let image_url = req.body.image_url; // Keep the old one by default
    if (req.file) {
        image_url = req.file.path; // Or use the new one
    }

    await pool.query(
        "UPDATE main_banners SET title = ?, subtitle = ?, image_url = ?, link_url = ?, button_text = ?, badge_text = ?, is_active = ? WHERE id = ?",
        [title, subtitle, image_url, link_url, button_text, badge_text, is_active === 'true', id]
    );
    res.status(200).json({ message: 'Banner updated successfully' });
});

// @desc    Admin: Delete a main banner
// @route   DELETE /api/main-banners/:id
// @access  Admin
exports.deleteBanner = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await pool.query("DELETE FROM main_banners WHERE id = ?", [id]);
    res.status(200).json({ message: 'Banner deleted successfully' });
});

// @desc    Public: Get all ACTIVE main banners for homepage
// @route   GET /api/browse/main-banners
// @access  Public
exports.getActiveBanners = asyncHandler(async (req, res) => {
    const [banners] = await pool.query("SELECT * FROM main_banners WHERE is_active = 1 ORDER BY created_at DESC");
    res.status(200).json(banners);
});