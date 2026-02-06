// backend/controllers/userController.js
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const asyncHandler = require("express-async-handler");

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

// backend/controllers/userController.js

exports.getUserProfile = asyncHandler(async (req, res) => {
    try {
        // ✨ التعديل هنا: إضافة is_super_admin و permissions إلى القائمة المختارة
        const [users] = await pool.query(
            'SELECT id, name, email, role_id, phone_number, address, verification_status, has_accepted_agreement, profile_picture_url, store_banner_url, is_super_admin, permissions FROM users WHERE id = ?', 
            [req.user.id]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ message: 'المستخدم غير موجود.' });
        }
        
        const user = users[0];

        // ✨ معالجة هامة: تحويل الصلاحيات من نص JSON إلى كائن (Object) إذا لزم الأمر
        // لأن MySQL قد يرجعها كنص أحياناً
        if (user.permissions && typeof user.permissions === 'string') {
            try {
                user.permissions = JSON.parse(user.permissions);
            } catch (e) {
                console.error("Error parsing permissions:", e);
                user.permissions = {};
            }
        }

        // تنسيق رقم الهاتف (اختياري)
        if (user.phone_number && !user.phone) {
            user.phone = user.phone_number;
        }

        res.status(200).json(user);
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
  // 1. استقبال 'phone' لأن الفرونت إند يرسلها بهذا الاسم
  const { name, email, phone, phone_number, address, password } = req.body;
  const userId = req.user.id;

  // توحيد مصدر رقم الهاتف (سواء أرسل phone أو phone_number)
  const phoneToSave = phone || phone_number;

  if (!name || !email) {
    return res
      .status(400)
      .json({ message: "الاسم والبريد الإلكتروني حقول مطلوبة." });
  }

  try {
    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ? AND id != ?",
      [email, userId]
    );

    if (existingUsers.length > 0) {
      return res
        .status(409)
        .json({ message: "هذا البريد الإلكتروني مسجل بالفعل." });
    }

    // 2. تحديث الاستعلام لاستخدام phoneToSave في عمود phone_number
    let query =
      "UPDATE users SET name = ?, email = ?, phone_number = ?, address = ?";
    const params = [name, email, phoneToSave || null, address || null];

    if (password && password.length >= 6) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      query += ", password = ?";
      params.push(hashedPassword);
    }

    query += " WHERE id = ?";
    params.push(userId);

    await pool.query(query, params);

    // إرجاع البيانات المحدثة
    const [updatedUsers] = await pool.query(
      "SELECT id, name, email, role_id, phone_number, address, profile_picture_url FROM users WHERE id = ?",
      [userId]
    );

    // تنسيق الرد ليتوافق مع الفرونت إند
    const updatedUser = updatedUsers[0];
    updatedUser.phone = updatedUser.phone_number; // إضافة حقل phone للرد

    res.status(200).json({
      message: "تم تحديث ملفك الشخصي بنجاح!",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "فشل تحديث الملف الشخصي." });
  }
});

/**
 * @desc    Get user shipping addresses
 * @route   GET /api/users/addresses
 * @access  Private
 */
exports.getUserAddresses = asyncHandler(async (req, res) => {
  const [addresses] = await pool.query(
    "SELECT * FROM addresses WHERE user_id = ?",
    [req.user.id]
  );
  res.json(addresses);
});

/**
 * @desc    Add a new shipping address
 * @route   POST /api/users/addresses
 * @access  Private
 */
exports.addAddress = asyncHandler(async (req, res) => {
  const {
    fullName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    phoneNumber,
    latitude,   // ✨ جديد
    longitude,  // ✨ جديد
    is_default  // ✨ جديد
  } = req.body;
  
  const userId = req.user.id;

  // التحقق من المدخلات الأساسية
  if (
    !fullName ||
    !addressLine1 ||
    !city ||
    !state ||
    !postalCode ||
    !country ||
    !phoneNumber
  ) {
    res.status(400);
    throw new Error("الرجاء تعبئة جميع الحقول المطلوبة.");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. إذا تم تعيين العنوان كافتراضي، قم بإلغاء الافتراضي من العناوين السابقة
    if (is_default === true || is_default === 1 || is_default === '1') {
      await connection.query(
        "UPDATE addresses SET is_default = 0 WHERE user_id = ?",
        [userId]
      );
    }

    // 2. إضافة العنوان الجديد مع الإحداثيات
    const [result] = await connection.query(
      `INSERT INTO addresses 
      (user_id, full_name, address_line_1, address_line_2, city, state_province_region, postal_code, country, phone_number, latitude, longitude, is_default) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        fullName,
        addressLine1,
        addressLine2 || null,
        city,
        state,
        postalCode,
        country,
        phoneNumber,
        latitude || null,   // تخزين الإحداثيات
        longitude || null,  // تخزين الإحداثيات
        is_default ? 1 : 0
      ]
    );

    await connection.commit();

    // جلب العنوان المضاف لإعادته للفرونت إند
    const [newAddress] = await pool.query(
      "SELECT * FROM addresses WHERE id = ?",
      [result.insertId]
    );
    
    res.status(201).json(newAddress[0]);

  } catch (error) {
    await connection.rollback();
    res.status(500);
    throw error;
  } finally {
    connection.release();
  }
});

/**
 * @desc    Update a shipping address
 * @route   PUT /api/users/addresses/:id
 * @access  Private
 */
exports.updateAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    fullName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    phoneNumber,
    latitude,   // ✨ جديد
    longitude,  // ✨ جديد
    is_default  // ✨ جديد
  } = req.body;

  const userId = req.user.id; // تأكيد الملكية

  const connection = await pool.getConnection();

  try {
    // التحقق من وجود العنوان وملكيته
    const [address] = await connection.query(
      "SELECT * FROM addresses WHERE id = ? AND user_id = ?",
      [id, userId]
    );

    if (address.length === 0) {
      res.status(404);
      throw new Error("العنوان غير موجود");
    }

    await connection.beginTransaction();

    // 1. معالجة العنوان الافتراضي
    if (is_default === true || is_default === 1 || is_default === '1') {
      await connection.query(
        "UPDATE addresses SET is_default = 0 WHERE user_id = ?",
        [userId]
      );
    }

    // 2. تحديث البيانات
    await connection.query(
      `UPDATE addresses SET 
        full_name = ?, 
        address_line_1 = ?, 
        address_line_2 = ?, 
        city = ?, 
        state_province_region = ?, 
        postal_code = ?, 
        country = ?, 
        phone_number = ?,
        latitude = ?, 
        longitude = ?,
        is_default = ?
      WHERE id = ?`,
      [
        fullName,
        addressLine1,
        addressLine2 || null,
        city,
        state,
        postalCode,
        country,
        phoneNumber,
        latitude || null,
        longitude || null,
        is_default ? 1 : 0,
        id
      ]
    );

    await connection.commit();

    const [updatedAddress] = await pool.query(
      "SELECT * FROM addresses WHERE id = ?",
      [id]
    );
    res.json(updatedAddress[0]);

  } catch (error) {
    await connection.rollback();
    res.status(500);
    throw error;
  } finally {
    connection.release();
  }
});

/**
 * @desc    Delete a shipping address
 * @route   DELETE /api/users/addresses/:id
 * @access  Private
 */
exports.deleteAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [address] = await pool.query(
    "SELECT * FROM addresses WHERE id = ? AND user_id = ?",
    [id, req.user.id]
  );

  if (address.length === 0) {
    res.status(404);
    throw new Error("العنوان غير موجود");
  }

  await pool.query("DELETE FROM addresses WHERE id = ?", [id]);
  res.json({ message: "تم حذف العنوان بنجاح" });
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
    await connection.query(
      "UPDATE addresses SET is_default = FALSE WHERE user_id = ?",
      [userId]
    );

    // 2. تعيين العنوان المحدد كافتراضي
    const [result] = await connection.query(
      "UPDATE addresses SET is_default = TRUE WHERE id = ? AND user_id = ?",
      [id, userId]
    );

    if (result.affectedRows === 0) {
      throw new Error("العنوان غير موجود أو لا تملكه");
    }

    await connection.commit();
    res.json({ message: "تم تعيين العنوان كافتراضي بنجاح" });
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

  // [2] استقبال البيانات (تم إضافة bank_name و account_holder_name)
  const {
    identity_number,
    social_links,
    stats,
    bank_name, // حقل جديد يفضل إرساله من الفرونت إند
    account_holder_name, // حقل جديد يفضل إرساله من الفرونت إند
    account_number,
    iban,
  } = req.body;

  // [3] استقبال الملفات
  const files = req.files;

  // [4] التحقق من البيانات الأساسية
  if (
    !identity_number ||
    !files ||
    !files.identity_image ||
    !iban ||
    !files.iban_certificate
  ) {
    res.status(400);
    throw new Error(
      "رقم الهوية، صورة الهوية، الآيبان، وشهادة الآيبان، كلها مطلوبة."
    );
  }

  // [5] التحقق من الطلبات السابقة
  const connection = await pool.getConnection(); // نبدأ الاتصال هنا لنستخدمه في التحقق والقراءة
  
  try {
    const [[existingUser]] = await connection.query(
      "SELECT name, verification_status FROM users WHERE id = ?",
      [userId]
    );

    if (
      existingUser.verification_status === "pending" ||
      existingUser.verification_status === "approved"
    ) {
      res.status(400);
      throw new Error("لديك طلب تحقق بالفعل أو تم التحقق من حسابك.");
    }

    // [6] تحليل بيانات JSON
    const parsedSocialLinks =
      typeof social_links === "string" ? JSON.parse(social_links) : social_links;
    const parsedStats = typeof stats === "string" ? JSON.parse(stats) : stats;

    // تجهيز بيانات البنك الافتراضية إذا لم يتم إرسالها
    const finalAccountHolder = account_holder_name || existingUser.name || 'Unknown';
    const finalBankName = bank_name || 'Bank';

    // [7] بدء المعاملة (Transaction)
    await connection.beginTransaction();

    // [8] الخطوة الأولى: تحديث جدول `users` (بيانات الهوية والسوشيال)
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
        files.identity_image[0].path,
        JSON.stringify(parsedSocialLinks || {}),
        JSON.stringify(parsedStats || {}),
        userId,
      ]
    );

    // [9] الخطوة الثانية: إضافة/تحديث الجدول الموحد `bank_details`
    await connection.query(
      `INSERT INTO bank_details 
             (user_id, bank_name, account_holder_name, account_number, iban, iban_certificate_url, status, is_verified) 
            VALUES (?, ?, ?, ?, ?, ?, 'approved', 0) 
            ON DUPLICATE KEY UPDATE 
              bank_name = VALUES(bank_name),
              account_holder_name = VALUES(account_holder_name),
              account_number = VALUES(account_number), 
              iban = VALUES(iban), 
              iban_certificate_url = VALUES(iban_certificate_url),
              status = 'approved',
              is_verified = 0`,
      [
        userId,
        finalBankName,       // الحقل الجديد
        finalAccountHolder,  // الحقل الجديد
        account_number,
        iban,
        files.iban_certificate[0].path,
      ]
    );

    // [10] إنهاء المعاملة
    await connection.commit();
    res
      .status(200)
      .json({
        message: "تم إرسال طلب التحقق بنجاح، ستتم مراجعته من قبل الإدارة.",
      });
  } catch (error) {
    await connection.rollback();
    console.error("Error submitting user verification:", error);
    // التحقق من نوع الخطأ لإرسال رسالة مناسبة
    if (res.statusCode === 200) res.status(500); 
    if (!res.headersSent) res.json({ message: error.message || "فشل في تقديم بيانات التوثيق." });
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
    return res.status(400).json({ message: "Please upload an image file" });
  }

  // The image URL is provided by the uploadMiddleware (e.g., from Cloudinary)
  const imageUrl = req.file.path;

  await pool.query("UPDATE users SET profile_picture_url = ? WHERE id = ?", [
    imageUrl,
    userId,
  ]);

  res.status(200).json({
    message: "Profile picture updated successfully",
    profile_picture_url: imageUrl,
  });
});

// @desc    جلب بيانات الملف الشخصي العام لمستخدم معين
// @route   GET /api/users/:id/profile
// @access  Public
exports.getUserPublicProfile = asyncHandler(async (req, res) => {
  const userIdToView = req.params.id;
  const currentUserId = req.user?.id;

  try {
    // --- 1. جلب بيانات المستخدم + حالة المتابعة + عدد المتابعين الداخليين ---
    const userQuery = `
      SELECT 
        u.id, 
        u.name, 
        u.profile_picture_url, 
        u.store_banner_url, 
        u.bio, 
        u.stats, 
        u.social_links, 
        u.portfolio, 
        u.is_verified, 
        r.name as role_name,
        -- ✅ التحقق مما إذا كنت تتابعه
        ${
          currentUserId
            ? `(SELECT COUNT(*) FROM user_follows uf WHERE uf.follower_id = ? AND uf.following_id = u.id) > 0`
            : "FALSE"
        } as isFollowedByMe,
        -- ✅ حساب عدد المتابعين في المنصة
        (SELECT COUNT(*) FROM user_follows uf WHERE uf.following_id = u.id) as followers_count
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = ? 
        AND u.is_banned = 0 
        AND r.name IN ('العارضة', 'المؤثرة');
    `;

    const userQueryParams = currentUserId
      ? [currentUserId, userIdToView]
      : [userIdToView];

    const [userResult] = await pool.query(userQuery, userQueryParams);

    if (userResult.length === 0) {
      return res.status(404).json({ message: "User profile not found." });
    }

    let userProfile = userResult[0];
    userProfile.isFollowedByMe = Boolean(userProfile.isFollowedByMe);

    // معالجة JSON
    try {
      userProfile.stats = userProfile.stats ? JSON.parse(userProfile.stats) : {};
      userProfile.social_links = userProfile.social_links ? JSON.parse(userProfile.social_links) : {};
      userProfile.portfolio = userProfile.portfolio ? JSON.parse(userProfile.portfolio) : [];
    } catch (e) {
      userProfile.stats = {}; userProfile.social_links = {}; userProfile.portfolio = [];
    }

    // --- 2. جلب Reels (تم إضافة الأعمدة الناقصة) ---
    const reelsQuery = `
      SELECT 
        r.id, 
        r.video_url, 
        r.thumbnail_url, 
        r.caption,       -- ✅ جلب الوصف الحقيقي
        r.views_count,
        r.shares_count,  -- ✅ جلب عدد المشاركات الحقيقي
        r.created_at,    -- ✅ جلب تاريخ الإنشاء الحقيقي
        (SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id) as likes_count,
        (SELECT COUNT(*) FROM reel_comments rc WHERE rc.reel_id = r.id) as comments_count,
        ${
          currentUserId
            ? `(SELECT COUNT(*) FROM reel_likes rl WHERE rl.reel_id = r.id AND rl.user_id = ?) > 0`
            : "FALSE"
        } as isLikedByMe
        -- ❌ تم حذف isFollowedByMe من هنا لأنه مكرر، سنستخدم القيمة من userProfile
      FROM reels r
      WHERE r.user_id = ? AND r.is_active = 1
      ORDER BY r.created_at DESC
      LIMIT 12;
    `;

    const reelsQueryParams = currentUserId
      ? [currentUserId, userIdToView]
      : [userIdToView];

    const [reelsResult] = await pool.query(reelsQuery, reelsQueryParams);

    // --- 3. جلب الخدمات والباقات ---
    let servicesResult = [];
    let offersResult = [];
    
    if (userProfile.role_name === "العارضة") {
      const servicesQuery = `
        SELECT sp.id, sp.title, sp.description, 
               (SELECT MIN(pt.price) FROM package_tiers pt WHERE pt.package_id = sp.id) as starting_price
        FROM service_packages sp
        WHERE sp.user_id = ? AND sp.status = 'active'
        ORDER BY sp.created_at DESC;
      `;
      [servicesResult] = await pool.query(servicesQuery, [userIdToView]);

      const offersQuery = `
        SELECT id, title, description, price, type 
        FROM offers 
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at DESC;
      `;
      [offersResult] = await pool.query(offersQuery, [userIdToView]);
    }

    // --- 4. جلب المنتجات وربطها ---
    const reelIds = reelsResult.map((r) => r.id);
    const productMap = new Map();

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
      const [taggedProducts] = await pool.query(queryTags, [reelIds]);

      for (const product of taggedProducts) {
        const reelId = product.reel_id;
        if (!productMap.has(reelId)) productMap.set(reelId, []);
        const { reel_id, ...productDetails } = product;
        productMap.get(reelId).push(productDetails);
      }
    }

    // تنسيق الريلز النهائي
    const formattedReels = reelsResult.map((reel) => ({
      ...reel,
      tagged_products: productMap.get(reel.id) || [],
      userId: userIdToView,
      userName: userProfile.name,
      userAvatar: userProfile.profile_picture_url,
      // ✅ استخدام القيم الحقيقية من قاعدة البيانات
      caption: reel.caption || "", 
      shares_count: reel.shares_count || 0,
      created_at: reel.created_at,
      // ✅ تمرير حالة المتابعة من البروفايل (لأنها نفس المستخدم)
      isFollowedByMe: userProfile.isFollowedByMe, 
      isLikedByMe: Boolean(reel.isLikedByMe),
    }));

    const responseData = {
      profile: userProfile, // يحتوي الآن على followers_count
      reels: formattedReels,
      services: servicesResult,
      offers: offersResult,
    };

    res.status(200).json(responseData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});
// backend/controllers/userController.js

/**
 * @desc    Get user stats (Orders count, Points, Favorites)
 * @route   GET /api/users/stats
 * @access  Private
 */
exports.getUserStats = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. حساب عدد الطلبات المكتملة فقط (status = 'delivered')
    // ملاحظة: تأكد أن اسم العمود هو user_id أو customer_id حسب جدول orders لديك
    const [ordersResult] = await pool.query(
      "SELECT COUNT(*) as count FROM orders WHERE customer_id = ? AND status = 'completed'",
      [userId]
    );
    const completedOrders = ordersResult[0].count || 0;

    // 2. حساب النقاط (10 نقاط لكل طلب مكتمل)
    const points = completedOrders * 10;

    // 3. حساب عدد العناصر في المفضلة (Wishlist)
    // ملاحظة: تأكد من اسم جدول المفضلة (wishlist أو favorites)
    const [wishlistResult] = await pool.query(
      "SELECT COUNT(*) as count FROM wishlist WHERE user_id = ?",
      [userId]
    );
    const favoritesCount = wishlistResult[0].count || 0;

    const [notifResult] = await pool.query(
      "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE",
      [userId]
    );

    const unreadNotifications = notifResult[0].count || 0;

    // 4. منطق تحديد مستوى العضوية (Membership Level)
    let membership = "Bronze";
    let nextLevelPoints = 100;
    let progress = 0;

    if (points < 100) {
      membership = "Bronze";
      nextLevelPoints = 100;
      progress = (points / 100) * 100;
    } else if (points < 500) {
      membership = "Silver";
      nextLevelPoints = 500;
      progress = ((points - 100) / 400) * 100;
    } else if (points < 1000) {
      membership = "Gold";
      nextLevelPoints = 1000;
      progress = ((points - 500) / 500) * 100;
    } else {
      membership = "Platinum";
      nextLevelPoints = 0; // وصل للحد الأقصى
      progress = 100;
    }

    res.status(200).json({
      orders: completedOrders,
      points: points,
      favorites: favoritesCount,
      notifications: unreadNotifications,
      membership: membership,
      progress: Math.round(progress), // نسبة مئوية صحيحة
      nextLevelPoints: nextLevelPoints > 0 ? nextLevelPoints - points : 0,
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({ message: "Server Error fetching stats" });
  }
});
