// backend/controllers/marqueeController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

// @desc    Get all marquee messages (Admin)
// @route   GET /api/marquee
// @access  Private/Admin
exports.getMarqueeMessages = asyncHandler(async (req, res) => {
  const [messages] = await pool.query("SELECT * FROM marquee_messages ORDER BY created_at DESC");
  res.json(messages);
});

// @desc    Get only active marquee messages (Public)
// @route   GET /api/marquee/active
// @access  Public
exports.getActiveMarqueeMessages = asyncHandler(async (req, res) => {
  const [messages] = await pool.query("SELECT * FROM marquee_messages WHERE is_active = TRUE ORDER BY created_at DESC");
  res.json(messages);
});

// @desc    Create a new marquee message (Admin)
// @route   POST /api/marquee
// @access  Private/Admin
exports.createMarqueeMessage = asyncHandler(async (req, res) => {
  const { message_text } = req.body;
  if (!message_text) {
    return res.status(400).json({ message: "Message text is required" });
  }
  const [result] = await pool.query("INSERT INTO marquee_messages (message_text) VALUES (?)", [message_text]);
  const [newMessage] = await pool.query("SELECT * FROM marquee_messages WHERE id = ?", [result.insertId]);
  res.status(201).json(newMessage[0]);
});

// @desc    Update a marquee message (Admin)
// @route   PUT /api/marquee/:id
// @access  Private/Admin
exports.updateMarqueeMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message_text, is_active } = req.body;

  const [message] = await pool.query("SELECT * FROM marquee_messages WHERE id = ?", [id]);
  if (message.length === 0) {
    return res.status(404).json({ message: "Message not found" });
  }

  // تحديد الحقول المراد تحديثها
  const newText = message_text !== undefined ? message_text : message[0].message_text;
  const newStatus = is_active !== undefined ? is_active : message[0].is_active;

  await pool.query("UPDATE marquee_messages SET message_text = ?, is_active = ? WHERE id = ?", [newText, newStatus, id]);
  
  const [updatedMessage] = await pool.query("SELECT * FROM marquee_messages WHERE id = ?", [id]);
  res.json(updatedMessage[0]);
});

// @desc    Delete a marquee message (Admin)
// @route   DELETE /api/marquee/:id
// @access  Private/Admin
exports.deleteMarqueeMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query("DELETE FROM marquee_messages WHERE id = ?", [id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ message: "Message not found" });
  }
  res.json({ message: "Message deleted successfully" });
});