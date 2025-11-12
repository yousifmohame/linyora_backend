// backend/controllers/userController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const asyncHandler = require('express-async-handler');

/**
 * @desc    Follow a user
 * @route   POST /api/users/:id/follow
 * @access  Private
 */
exports.followUser = asyncHandler(async (req, res) => {
  const followerId = req.user.id; // المستخدم المسجل
  const followingId = req.params.id; // المستخدم المُراد متابعته

  if (Number(followerId) === Number(followingId)) {
    res.status(400);
    throw new Error("You cannot follow yourself");
  }

  try {
    // `INSERT IGNORE` يتجاهل الطلب إذا كان موجوداً مسبقاً (يمنع التكرار)
    const [result] = await pool.query(
      "INSERT IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)",
      [followerId, followingId]
    );

    if (result.affectedRows === 0) {
      return res.status(200).json({ message: "Already following" });
    }

    res.status(201).json({ message: "User followed successfully" });
  } catch (error) {
    res.status(500);
    throw new Error("Server error while trying to follow user");
  }
});

/**
 * @desc    Unfollow a user
 * @route   DELETE /api/users/:id/follow
 * @access  Private
 */
exports.unfollowUser = asyncHandler(async (req, res) => {
  const followerId = req.user.id;
  const followingId = req.params.id;

  const [result] = await pool.query(
    "DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?",
    [followerId, followingId]
  );

  if (result.affectedRows === 0) {
    res.status(404);
    throw new Error("Follow relationship not found");
  }

  res.status(200).json({ message: "User unfollowed successfully" });
});

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


/**
 * @desc    Submit user's identity, social media, and BANK verification
 * @route   POST /api/users/submit-verification
 * @access  Private (Models, Influencers, etc.)
 */
exports.submitVerification = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    
    // [2] استقبال جميع البيانات (القديمة + بيانات البنك)
    const { 
      identity_number, 
      social_links, 
      stats,          // <-- إضافة
      account_number,      // <-- إضافة
      iban                 // <-- إضافة
    } = req.body;
    
    // [3] استخدام req.files (لأننا نتوقع ملفين الآن)
    const files = req.files;

    // [4] التحقق من البيانات الأساسية (مثل كود التاجر)
    if (
      !identity_number ||
      !files || !files.identity_image ||
      !iban ||
      !files.iban_certificate
    ) {
        res.status(400);
        throw new Error('رقم الهوية، صورة الهوية، الآيبان، وشهادة الآيبان، كلها مطلوبة.');
    }

    // [5] التحقق من الطلبات السابقة (من الكود الأصلي)
    const [[existingUser]] = await pool.query("SELECT verification_status FROM users WHERE id = ?", [userId]);
    if (existingUser.verification_status === 'pending' || existingUser.verification_status === 'approved') {
        res.status(400);
        throw new Error('لديك طلب تحقق بالفعل أو تم التحقق من حسابك.');
    }

    // [6] تحليل بيانات JSON (من الكود الأصلي)
    const parsedSocialLinks = typeof social_links === 'string' ? JSON.parse(social_links) : social_links;
    const parsedStats = typeof stats === 'string' ? JSON.parse(stats) : stats;

    // [7] بدء المعاملة (Transaction)
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // [8] الخطوة الأولى: تحديث جدول `users` (الكود الأصلي)
        await connection.query(
            `UPDATE users SET 
                identity_number = ?, 
                identity_image_url = ?, 
                social_links = ?, 
                stats = ?, 
                verification_status = 'pending' 
             WHERE id = ?`,
            [
              identity_number, 
              files.identity_image[0].path, // المسار من Cloudinary
              JSON.stringify(parsedSocialLinks || {}), 
              JSON.stringify(parsedStats || {}), 
              userId
            ]
        );

        // [9] الخطوة الثانية: إضافة/تحديث "الجدول الموحد" `merchant_bank_details`
        await connection.query(
          `INSERT INTO merchant_bank_details 
            (user_id, account_number, iban, iban_certificate_url) 
           VALUES (?, ?, ?, ?) 
           ON DUPLICATE KEY UPDATE 
             account_number = VALUES(account_number), 
             iban = VALUES(iban), 
             iban_certificate_url = VALUES(iban_certificate_url)`,
          [
            userId,
            account_number,
            iban,
            files.iban_certificate[0].path, // المسار من Cloudinary
          ]
        );

        // [10] إنهاء المعاملة
        await connection.commit();
        res.status(200).json({ message: 'تم إرسال طلب التحقق بنجاح، ستتم مراجعته من قبل الإدارة.' });

    } catch (error) {
        await connection.rollback();
        console.error("Error submitting user verification:", error);
        res.status(500).json({ message: "فشل في تقديم بيانات التوثيق." });
    } finally {
        connection.release();
    }
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

// @desc    جلب بيانات الملف الشخصي العام لمستخدم معين
// @route   GET /api/users/:id/profile
// @access  Public
exports.getUserPublicProfile = asyncHandler( async (req, res) => {
  const userIdToView = req.params.id;
  const currentUserId = req.user?.id; // 👈 جلب هوية المستخدم الحالي
  try {
    // --- 1. جلب بيانات المستخدم الأساسية + حالة المتابعة ---
    const userQuery = `
      SELECT 
        u.id, 
        u.name, 
        u.profile_picture_url, 
        u.bio, 
        u.stats, 
        u.social_links, 
        u.portfolio, 
        u.is_verified, 
        r.name as role_name,
        ${
          currentUserId
            ? `(SELECT COUNT(*) FROM user_follows uf WHERE uf.follower_id = ? AND uf.following_id = u.id) > 0`
            : "FALSE"
        } as isFollowedByMe
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = ? 
        AND u.is_banned = 0 
        AND r.name IN ('العارضة', 'المؤثرة');
    `;

    // تحديد معاملات الاستعلام حسب وجود currentUserId
    const userQueryParams = currentUserId 
      ? [currentUserId, userIdToView] 
      : [userIdToView];

    const [userResult] = await pool.query(userQuery, userQueryParams);

    if (userResult.length === 0) {
      return res.status(404).json({ message: 'User profile not found or not public.' });
    }

    let userProfile = userResult[0];

    // تحويل isFollowedByMe إلى boolean
    userProfile.isFollowedByMe = Boolean(userProfile.isFollowedByMe);

    // معالجة الحقول JSON
    try {
      userProfile.stats = userProfile.stats ? JSON.parse(userProfile.stats) : {};
      userProfile.social_links = userProfile.social_links ? JSON.parse(userProfile.social_links) : {};
      userProfile.portfolio = userProfile.portfolio ? JSON.parse(userProfile.portfolio) : [];
    } catch (parseError) {
      userProfile.stats = {};
      userProfile.social_links = {};
      userProfile.portfolio = [];
    }

    // --- 2. جلب Reels مع isLikedByMe و isFollowedByMe (اختياري لكن موصى به) ---
    const reelsQuery = `
      SELECT 
        r.id, 
        r.video_url, 
        r.thumbnail_url, 
        r.views_count,
        (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count,
        (SELECT COUNT(*) FROM reel_comments rc WHERE rc.reel_id = r.id) as comments_count,
        ${
          currentUserId
            ? `(SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id AND rl.user_id = ?) > 0`
            : "FALSE"
        } as isLikedByMe,
        ${
          currentUserId
            ? `(SELECT COUNT(*) FROM user_follows uf WHERE uf.follower_id = ? AND uf.following_id = ?) > 0`
            : "FALSE"
        } as isFollowedByMe
      FROM reels r
      WHERE r.user_id = ? AND r.is_active = 1
      ORDER BY r.created_at DESC
      LIMIT 12;
    `;

    const reelsQueryParams = currentUserId
      ? [currentUserId, currentUserId, userIdToView, userIdToView]
      : [userIdToView];

    const [reelsResult] = await pool.query(reelsQuery, reelsQueryParams);

    // تحويل القيم المنطقية
    const reels = reelsResult.map(reel => ({
      ...reel,
      isLikedByMe: Boolean(reel.isLikedByMe),
      isFollowedByMe: Boolean(reel.isFollowedByMe),
    }));

    // --- 3. جلب الخدمات والباقات ---
    let servicesResult = [];
    if (userProfile.role_name === 'العارضة') {
      const servicesQuery = `
        SELECT sp.id, sp.title, sp.description, 
               (SELECT MIN(pt.price) FROM package_tiers pt WHERE pt.package_id = sp.id) as starting_price
        FROM service_packages sp
        WHERE sp.user_id = ? AND sp.status = 'active'
        ORDER BY sp.created_at DESC;
      `;
      [servicesResult] = await pool.query(servicesQuery, [userIdToView]);
    }

    let offersResult = [];
    if (userProfile.role_name === 'العارضة') {
      const offersQuery = `
        SELECT id, title, description, price, type 
        FROM offers 
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at DESC;
      `;
      [offersResult] = await pool.query(offersQuery, [userIdToView]);
    }

    // --- 4. جلب المنتجات الموسومة في الـ Reels (اختياري لكن متسق) ---
    const reelIds = reels.map(r => r.id);
    let taggedProducts = [];
    if (reelIds.length > 0) {
      const queryTags = `
        SELECT 
          rpt.reel_id, p.id, p.name, 
          (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]'))
          FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1
          ) as image_url
        FROM reel_product_tags rpt 
        JOIN products p ON rpt.product_id = p.id 
        WHERE rpt.reel_id IN (?);
      `;
      [taggedProducts] = await pool.query(queryTags, [reelIds]);
    }

    const productMap = new Map();
    for (const product of taggedProducts) {
      const reelId = product.reel_id;
      if (!productMap.has(reelId)) {
        productMap.set(reelId, []);
      }
      const { reel_id, ...productDetails } = product;
      productMap.get(reelId).push(productDetails);
    }

    const formattedReels = reels.map(reel => ({
      ...reel,
      tagged_products: productMap.get(reel.id) || [],
      userId: userIdToView,
      userName: userProfile.name,
      userAvatar: userProfile.profile_picture_url,
      caption: '', // أو اجلبه من قاعدة البيانات إذا كان موجودًا
      shares_count: 0, // أو اجلبه إذا كان مخزنًا
      created_at: reel.created_at || new Date().toISOString(),
    }));

    const responseData = {
      profile: userProfile,
      reels: formattedReels,
      services: servicesResult,
      offers: offersResult,
    };
    res.status(200).json(responseData);

  } catch (error) {
    res.status(500).json({ message: 'Server error while fetching user profile' });
  }
});