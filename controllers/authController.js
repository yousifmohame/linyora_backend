// linora-platform/backend/controllers/authController.js

const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates");

// Helper function to generate a verification code
const generateVerificationCode = () =>
  crypto.randomInt(100000, 999999).toString();
const getCodeExpiration = () => new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.register = asyncHandler(async (req, res) => {
  // ... (كود التسجيل الخاص بك يبقى كما هو)
  // ...
  const { name, email, password, phoneNumber, roleId } = req.body;

  if (!name || !email || !password || !roleId) {
    res.status(400);
    throw new Error("Please provide all required fields.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[existingUser]] = await connection.query(
      "SELECT id, is_email_verified FROM users WHERE email = ?",
      [email]
    );

    const verificationCode = generateVerificationCode();
    const expiration = getCodeExpiration();
    const hashedPassword = await bcrypt.hash(password, 10);

    let userId;

    if (existingUser) {
      if (existingUser.is_email_verified) {
        await connection.rollback();
        res.status(409); // 409 Conflict
        throw new Error("An account with this email already exists.");
      } else {
        // User exists but is unverified. Update their details and resend code.
        userId = existingUser.id;
        await connection.query(
          "UPDATE users SET name = ?, password = ?, phone_number = ?, role_id = ?, email_verification_code = ?, email_verification_expires = ? WHERE id = ?",
          [
            name,
            hashedPassword,
            phoneNumber,
            roleId,
            verificationCode,
            expiration,
            userId,
          ]
        );
      }
    } else {
      // New user. Create a new record.
      const [result] = await connection.query(
        "INSERT INTO users (name, email, password, phone_number, role_id, email_verification_code, email_verification_expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          name,
          email,
          hashedPassword,
          phoneNumber,
          roleId,
          verificationCode,
          expiration,
        ]
      );
      userId = result.insertId;
    }

    await sendEmail({
      to: email,
      subject: "تفعيل حسابك في لينيورا",
      html: templates.authVerificationCode(verificationCode, "تفعيل الحساب الجديد"),
    });

    await connection.commit();

    res.status(201).json({
      message:
        "Registration successful! Please check your email for a verification code.",
      userId: userId,
    });
  } catch (error) {
    await connection.rollback();
    // Re-throw to be caught by the global error handler, which will send the correct status code
    throw error;
  } finally {
    connection.release();
  }
});

/**
 * @desc    Step 1: Validate credentials and send login code
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400);
    throw new Error("Please provide email and password.");
  }

  const [[user]] = await pool.query("SELECT * FROM users WHERE email = ?", [
    email,
  ]);

  if (!user) {
    res.status(401);
    throw new Error("Invalid credentials.");
  }

  // 1. التأكد أن المستخدم قام بتفعيل حسابه أصلاً
  if (!user.is_email_verified) {
    res.status(403); // 403 Forbidden
    throw new Error(
      "Email not verified. Please check your inbox for a verification code."
    );
  }

  // 2. التحقق من كلمة المرور
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    res.status(401);
    throw new Error("Invalid credentials.");
  }

  // 3. كلمة المرور صحيحة، الآن نرسل كود التحقق
  const loginCode = generateVerificationCode();
  const expiration = getCodeExpiration();

  // 4. حفظ الكود المؤقت في قاعدة البيانات (نستخدم نفس أعمدة تفعيل الإيميل)
  await pool.query(
    "UPDATE users SET email_verification_code = ?, email_verification_expires = ? WHERE id = ?",
    [loginCode, expiration, user.id]
  );

  // 5. إرسال الكود عبر الإيميل
  await sendEmail({
    to: email,
    subject: "رمز الدخول - لينيورا",
    html: templates.authVerificationCode(loginCode, "تسجيل الدخول"),
  });

  // 6. إرسال رسالة نجاح للواجهة الأمامية للانتقال للخطوة الثانية
  res.status(200).json({
    success: true,
    message: "Verification code sent to your email. Please check your inbox.",
  });
});

/**
 * @desc    Step 2: Verify login code and issue JWT
 * @route   POST /api/auth/verify-login
 * @access  Public
 */
exports.verifyLogin = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400);
    throw new Error("Email and code are required.");
  }

  const [[user]] = await pool.query("SELECT * FROM users WHERE email = ?", [
    email,
  ]);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  // التحقق من الكود ومن تاريخ انتهاء صلاحيته
  if (
    user.email_verification_code !== code ||
    new Date() > new Date(user.email_verification_expires)
  ) {
    res.status(400);
    throw new Error("Invalid or expired verification code.");
  }

  // الكود صحيح، قم بتنظيف قاعدة البيانات
  await pool.query(
    "UPDATE users SET email_verification_code = NULL, email_verification_expires = NULL WHERE id = ?",
    [user.id]
  );

  // الآن فقط نقوم بإنشاء التوكن وإرساله
  const token = jwt.sign(
    { id: user.id, role: user.role_id },
    process.env.JWT_SECRET,
    {
      expiresIn: "30d",
    }
  );

  res.json({
    message: "Login successful",
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role_id: user.role_id,
    },
  });
});

/**
 * @desc    Verify user's email with a code (For Registration)
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
exports.verifyEmail = asyncHandler(async (req, res) => {
  // ... (هذه الدالة تبقى كما هي، هي خاصة بالتسجيل)
  const { email, code } = req.body;

  if (!email || !code) {
    res.status(400);
    throw new Error("Email and verification code are required.");
  }

  // هذا السطر يضمن أنها تعمل فقط للحسابات غير المفعلة (is_email_verified = 0)
  const [[user]] = await pool.query(
    "SELECT id, email_verification_code, email_verification_expires FROM users WHERE email = ? AND is_email_verified = 0",
    [email]
  );

  if (!user) {
    res.status(404);
    throw new Error("User not found or already verified.");
  }

  if (
    user.email_verification_code !== code ||
    new Date() > new Date(user.email_verification_expires)
  ) {
    res.status(400);
    throw new Error("Invalid or expired verification code.");
  }

  const [[userData]] = await pool.query("SELECT name FROM users WHERE id = ?", [user.id]);

  await pool.query(
    "UPDATE users SET is_email_verified = 1, email_verification_code = NULL, email_verification_expires = NULL WHERE id = ?",
    [user.id]
  );

  if (userData) {
      await sendEmail({
          to: email,
          subject: `أهلاً بك في لينيورا، ${userData.name}! 🚀`,
          html: templates.welcomeEmail(userData.name)
      }).catch(console.error);
  }

  res
    .status(200)
    .json({ message: "Email verified successfully. You can now log in." });
});

// ... (باقي الدوال: resendVerification, forgotPassword, resetPassword تبقى كما هي)
exports.resendVerification = asyncHandler(async (req, res) => {
  // ... (الكود الحالي)
  const { email } = req.body;

  if (!email) {
    res.status(400);
    throw new Error("Email is required.");
  }

  const [[user]] = await pool.query(
    "SELECT id, is_email_verified FROM users WHERE email = ?",
    [email]
  );

  if (!user || user.is_email_verified) {
    res.status(404);
    throw new Error("User not found or is already verified.");
  }

  const verificationCode = generateVerificationCode();
  const expiration = getCodeExpiration();

  await pool.query(
    "UPDATE users SET email_verification_code = ?, email_verification_expires = ? WHERE id = ?",
    [verificationCode, expiration, user.id]
  );

  await sendEmail({
    to: email,
    subject: "رمز تفعيل جديد - لينيورا",
    html: templates.authVerificationCode(verificationCode, "إعادة إرسال الرمز"),
  });

  res
    .status(200)
    .json({ message: "A new verification code has been sent to your email." });
});

exports.forgotPassword = async (req, res) => {
  // ... (الكود الحالي)
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: "الرجاء إدخال البريد الإلكتروني." });
  }

  try {
    const [users] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      // ملاحظة: نرسل رسالة نجاح حتى لو لم يكن الإيميل موجوداً لحماية خصوصية المستخدمين
      return res.status(200).json({
        message:
          "إذا كان بريدك الإلكتروني مسجلاً، فستصلك رسالة لإعادة تعيين كلمة المرور.",
      });
    }

    const user = users[0];

    // 1. إنشاء رمز عشوائي
    const resetToken = crypto.randomBytes(32).toString("hex");

    // 2. تشفير الرمز قبل حفظه في قاعدة البيانات
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    // 3. تحديد تاريخ انتهاء الصلاحية (10 دقائق)
    const expirationTime = new Date(Date.now() + 10 * 60 * 1000);

    // 4. حفظ الرمز المشفر وتاريخ الانتهاء في سجل المستخدم
    await pool.query(
      "UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?",
      [hashedToken, expirationTime, user.id]
    );

    // 5. إنشاء رابط إعادة التعيين وإرساله عبر البريد الإلكتروني
    const resetURL = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: "إعادة تعيين كلمة المرور - منصة لينيورا",
      html: templates.passwordResetRequest(resetURL),
    });

    res.status(200).json({
      message:
        "إذا كان بريدك الإلكتروني مسجلاً، فستصلك رسالة لإعادة تعيين كلمة المرور.",
    });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    // مسح الرمز في حالة حدوث خطأ لمنع المشاكل
    await pool.query(
      "UPDATE users SET password_reset_token = NULL, password_reset_expires = NULL WHERE email = ?",
      [email]
    );
    res
      .status(500)
      .json({ message: "حدث خطأ أثناء محاولة إرسال البريد الإلكتروني." });
  }
};

exports.resetPassword = async (req, res) => {
  // ... (الكود الحالي)
  const { token } = req.params;
  const { password } = req.body;

  if (!password) {
    return res
      .status(400)
      .json({ message: "الرجاء إدخال كلمة المرور الجديدة." });
  }

  // 1. تشفير الرمز القادم من الرابط لمقارنته مع ما في قاعدة البيانات
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  try {
    // 2. البحث عن المستخدم باستخدام الرمز المشفر والتأكد من عدم انتهاء صلاحيته
    const [users] = await pool.query(
      "SELECT * FROM users WHERE password_reset_token = ? AND password_reset_expires > NOW()",
      [hashedToken]
    );

    if (users.length === 0) {
      return res
        .status(400)
        .json({ message: "الرمز غير صالح أو انتهت صلاحيته." });
    }

    const user = users[0];

    // 3. تشفير كلمة المرور الجديدة وتحديثها
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await pool.query(
      "UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?",
      [hashedPassword, user.id]
    );

    res.status(200).json({
      message: "تم تغيير كلمة المرور بنجاح! يمكنك الآن تسجيل الدخول.",
    });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إعادة تعيين كلمة المرور." });
  }
};
