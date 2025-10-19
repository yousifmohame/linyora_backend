// backend/controllers/userController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const asyncHandler = require('express-async-handler');


// [GET] جلب الملف الشخصي للمستخدم المسجل دخوله
/**
 * @desc    Get user profile data
 * @route   GET /api/users/profile
 * @access  Private
 */
exports.getUserProfile = asyncHandler(async (req, res) => {
    // We fetch the most up-to-date data directly from the database
    try {
        // Added 'profile_picture_url' to the selection
        const [users] = await pool.query(
            'SELECT id, name, email, role_id, phone_number, address, verification_status, has_accepted_agreement, profile_picture_url FROM users WHERE id = ?', 
            [req.user.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ message: 'المستخدم غير موجود.' });
        }
        
        res.status(200).json(users[0]);
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: 'خطأ في الخادم.' });
    }
});

/**
 * @desc    Update user profile information
 * @route   PUT /api/users/profile
 * @access  Private
 */
exports.updateUserProfile = asyncHandler(async (req, res) => {
    const { name, email, phone_number, address, password } = req.body; // Corrected 'phone' to 'phone_number' to match schema
    const userId = req.user.id;

    // Validate that name and email are present
    if (!name || !email) {
        return res.status(400).json({ message: 'الاسم والبريد الإلكتروني حقول مطلوبة.' });
    }

    try {
        // Check if the new email is already used by another user
        const [existingUsers] = await pool.query(
            "SELECT id FROM users WHERE email = ? AND id != ?",
            [email, userId]
        );

        if (existingUsers.length > 0) {
            return res.status(409).json({ message: "هذا البريد الإلكتروني مسجل بالفعل." });
        }

        let query = 'UPDATE users SET name = ?, email = ?, phone_number = ?, address = ?';
        const params = [name, email, phone_number || null, address || null];

        // If the user wants to change their password
        if (password && password.length >= 6) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            query += ', password = ?';
            params.push(hashedPassword);
        }

        query += ' WHERE id = ?';
        params.push(userId);

        await pool.query(query, params);

        // Fetch the updated user data to send back
        const [updatedUsers] = await pool.query('SELECT id, name, email, role_id, phone_number, address, profile_picture_url FROM users WHERE id = ?', [userId]);

        res.status(200).json({ 
            message: 'تم تحديث ملفك الشخصي بنجاح!',
            user: updatedUsers[0]
        });

    } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ message: 'فشل تحديث الملف الشخصي.' });
    }
});

/**
 * @desc    Get user shipping addresses
 * @route   GET /api/users/addresses
 * @access  Private
 */
exports.getUserAddresses = asyncHandler(async (req, res) => {
  const [addresses] = await pool.query('SELECT * FROM addresses WHERE user_id = ?', [req.user.id]);
  res.json(addresses);
});

/**
 * @desc    Add a new shipping address
 * @route   POST /api/users/addresses
 * @access  Private
 */
exports.addAddress = asyncHandler(async (req, res) => {
  const { fullName, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber } = req.body;
  const userId = req.user.id;

  // التحقق من المدخلات الأساسية
  if (!fullName || !addressLine1 || !city || !state || !postalCode || !country || !phoneNumber) {
    res.status(400);
    throw new Error('الرجاء تعبئة جميع الحقول المطلوبة.');
  }

  const [result] = await pool.query(
    'INSERT INTO addresses (user_id, full_name, address_line_1, address_line_2, city, state_province_region, postal_code, country, phone_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, fullName, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber]
  );

  const [newAddress] = await pool.query('SELECT * FROM addresses WHERE id = ?', [result.insertId]);
  res.status(201).json(newAddress[0]);
});

/**
 * @desc    Update a shipping address
 * @route   PUT /api/users/addresses/:id
 * @access  Private
 */
exports.updateAddress = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { fullName, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber } = req.body;
    
    const [address] = await pool.query('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [id, req.user.id]);
    
    if (address.length === 0) {
        res.status(404);
        throw new Error('العنوان غير موجود');
    }

    await pool.query(
        'UPDATE addresses SET full_name = ?, address_line_1 = ?, address_line_2 = ?, city = ?, state_province_region = ?, postal_code = ?, country = ?, phone_number = ? WHERE id = ?',
        [fullName, addressLine1, addressLine2, city, state, postalCode, country, phoneNumber, id]
    );

    const [updatedAddress] = await pool.query('SELECT * FROM addresses WHERE id = ?', [id]);
    res.json(updatedAddress[0]);
});


/**
 * @desc    Delete a shipping address
 * @route   DELETE /api/users/addresses/:id
 * @access  Private
 */
exports.deleteAddress = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [address] = await pool.query('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [id, req.user.id]);
    
    if (address.length === 0) {
        res.status(404);
        throw new Error('العنوان غير موجود');
    }

    await pool.query('DELETE FROM addresses WHERE id = ?', [id]);
    res.json({ message: 'تم حذف العنوان بنجاح' });
});


/**
 * @desc    Set an address as default
 * @route   PUT /api/users/addresses/:id/default
 * @access  Private
 */
exports.setDefaultAddress = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. إزالة العلامة الافتراضية عن جميع العناوين الأخرى للمستخدم
        await connection.query('UPDATE addresses SET is_default = FALSE WHERE user_id = ?', [userId]);

        // 2. تعيين العنوان المحدد كافتراضي
        const [result] = await connection.query('UPDATE addresses SET is_default = TRUE WHERE id = ? AND user_id = ?', [id, userId]);

        if (result.affectedRows === 0) {
            throw new Error('العنوان غير موجود أو لا تملكه');
        }

        await connection.commit();
        res.json({ message: 'تم تعيين العنوان كافتراضي بنجاح' });
    } catch (error) {
        await connection.rollback();
        res.status(404);
        throw error;
    } finally {
        connection.release();
    }
});

// @desc    User accepts the agreement
// @route   PUT /api/users/profile/accept-agreement
// @access  Private
exports.acceptAgreement = asyncHandler(async (req, res) => {
    const userId = req.user.id; // نحصل على هوية المستخدم من التوكن

    await pool.query(
        "UPDATE users SET has_accepted_agreement = TRUE WHERE id = ?",
        [userId]
    );

    res.json({ message: "Agreement accepted successfully." });
});

// أضف هذه الدالة في ملف userController.js

/**
 * @desc    Submit user's identity and social media verification
 * @route   POST /api/users/submit-verification
 * @access  Private (Models, Influencers, etc.)
 */
exports.submitVerification = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    // ✅ Get new social media and stats fields from the body
    const { identity_number, social_links, stats } = req.body;
    const identity_image_url = req.file?.path;

    if (!identity_number || !identity_image_url) {
        res.status(400);
        throw new Error('رقم الهوية وصورة الهوية مطلوبان.');
    }

    // Parse JSON strings if they are sent as strings
    const parsedSocialLinks = typeof social_links === 'string' ? JSON.parse(social_links) : social_links;
    const parsedStats = typeof stats === 'string' ? JSON.parse(stats) : stats;

    const [[existingUser]] = await pool.query("SELECT verification_status FROM users WHERE id = ?", [userId]);

    if (existingUser.verification_status === 'pending' || existingUser.verification_status === 'approved') {
        res.status(400);
        throw new Error('لديك طلب تحقق بالفعل أو تم التحقق من حسابك.');
    }

    // ✅ Update the user with identity, social links, and stats
    await pool.query(
        `UPDATE users SET 
            identity_number = ?, 
            identity_image_url = ?, 
            social_links = ?, 
            stats = ?, 
            verification_status = 'pending' 
         WHERE id = ?`,
        [identity_number, identity_image_url, JSON.stringify(parsedSocialLinks || {}), JSON.stringify(parsedStats || {}), userId]
    );

    res.status(200).json({ message: 'تم إرسال طلب التحقق بنجاح، ستتم مراجعته من قبل الإدارة.' });
});

// @desc    Update user profile picture
// @route   POST /api/users/profile/picture
// @access  Private
exports.updateProfilePicture = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (!req.file) {
        return res.status(400).json({ message: 'Please upload an image file' });
    }

    // The image URL is provided by the uploadMiddleware (e.g., from Cloudinary)
    const imageUrl = req.file.path;

    await pool.query("UPDATE users SET profile_picture_url = ? WHERE id = ?", [imageUrl, userId]);

    res.status(200).json({
        message: 'Profile picture updated successfully',
        profile_picture_url: imageUrl,
    });
});