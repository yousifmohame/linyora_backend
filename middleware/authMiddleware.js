const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ✨ التصحيح هنا: إضافة is_super_admin و permissions للاستعلام ✨
      const [rows] = await pool.query(
        "SELECT id, name, email, role_id, verification_status, is_super_admin, permissions FROM users WHERE id = ?",
        [decoded.id]
      );

      if (rows.length === 0) {
        return res.status(401).json({ message: "Not authorized, user not found" });
      }

      req.user = rows[0]; 
      
      // التأكد من أن الصلاحيات كائن وليست نصاً (في بعض قواعد البيانات)
      if (typeof req.user.permissions === 'string') {
          try {
              req.user.permissions = JSON.parse(req.user.permissions);
          } catch (e) {
              req.user.permissions = {};
          }
      }

      next();
    } catch (error) {
      console.error("Token verification failed:", error);
      res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  if (!token) {
    res.status(401).json({ message: "Not authorized, no token" });
  }
};

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role_id)) {
      return res
        .status(403)
        .json({ message: "ليس لديك الصلاحية للقيام بهذا الإجراء" });
    }
    next();
  };
};

const checkSubscription = asyncHandler(async (req, res, next) => {
  // هذه الدالة يجب أن تُستخدم بعد 'protect'
  const nonSubscriptionRoles = [1, 5]; // 1: Admin, 5: Supplier
  if (req.user && nonSubscriptionRoles.includes(req.user.role_id)) {
    return next(); // اسمح للمشرف والمورد بالمرور دائمًا
  }

  if (req.user) {
    try {
      const [subscription] = await pool.query(
        'SELECT * FROM user_subscriptions WHERE user_id = ? AND status = "active" AND end_date > NOW()',
        [req.user.id]
      );

      if (subscription.length > 0) {
        next(); // المستخدم لديه اشتراك فعال
      } else {
        res
          .status(403)
          .json({ message: "الوصول مرفوض. يتطلب اشتراكًا فعالاً." });
      }
    } catch (error) {
      console.error("Subscription check failed:", error);
      res
        .status(500)
        .json({ message: "خطأ في الخادم أثناء التحقق من الاشتراك." });
    }
  } else {
    res.status(401).json({ message: "غير مصرح به، لا يوجد توكن." });
  }
});

const isVerifiedMerchant = (req, res, next) => {
  // قمنا بتغيير req.user.roleId إلى req.user.role_id ليتطابق مع قاعدة البيانات
  if (
    req.user &&
    req.user.role_id === 2 &&
    req.user.verification_status === "approved"
  ) {
    next(); // اسمح بالمرور
  } else {
    // أرجع الخطأ إذا لم يكن الشرط صحيحاً
    res
      .status(403)
      .json({ message: "حسابك غير موثق بعد. لا يمكنك الوصول إلى هذه الميزة." });
  }
};

const isVerifiedSupplier = async (req, res, next) => {
  if (
    req.user &&
    req.user.role_id === 6 &&
    req.user.verification_status === "approved"
  ) {
    next();
  } else {
    res
      .status(403)
      .json({ message: "غير مصرح لك بالوصول، هذا الحساب ليس لمورد موثق." });
  }
};

// ✨ حارس جديد للتحقق من اشتراك الدروب شوبينج
const isDropshipper = asyncHandler(async (req, res, next) => {
  if (!req.user || req.user.role_id !== 2) {
    res.status(403);
    throw new Error("الوصول غير مصرح به.");
  }

  // ✅ جلب جميع الاشتراكات الفعّالة حاليًا فقط (نشطة وزمنيًا صالحة)
  const [subscriptions] = await pool.query(
    `SELECT sp.includes_dropshipping
         FROM user_subscriptions s
         JOIN subscription_plans sp ON s.plan_id = sp.id
         WHERE s.user_id = ?
           AND s.status = 'active'
           AND (s.start_date IS NULL OR s.start_date <= NOW())
           AND (s.end_date IS NULL OR s.end_date >= NOW())`,
    [req.user.id]
  );

  // ✅ التحقق من وجود أي اشتراك فعّال يحتوي على صلاحية الدروب شوبينج
  const hasAccess = subscriptions.some(
    (sub) => sub.includes_dropshipping === 1
  );

  if (hasAccess) {
    return next(); // ✅ لديه صلاحية
  }

  // ❌ لم يتم العثور على اشتراك يمنحه الوصول
  res.status(403);
  throw new Error(
    "غير مصرح لك بالوصول. هذه الميزة خاصة بمشتركي باقة الدروب شوبينج."
  );
});

/**
 * @desc    Middleware to check if the user has an active subscription
 * @protects Routes that require a subscription
 */
const requireSubscription = asyncHandler(async (req, res, next) => {
  // تفترض هذه الوظيفة أن 'protect' middleware قد تم تشغيله قبلها
  if (!req.user) {
    res.status(401);
    throw new Error("غير مصرح به، لم يتم العثور على المستخدم");
  }

  // تحقق من وجود اشتراك نشط في قاعدة البيانات
  const [subscriptions] = await pool.query(
    `SELECT id FROM user_subscriptions 
     WHERE user_id = ? 
       AND status = 'active' 
       AND NOW() BETWEEN start_date AND end_date
     LIMIT 1`,
    [req.user.id]
  );

  // إذا لم يتم العثور على أي اشتراك، أرجع خطأ "ممنوع"
  if (subscriptions.length === 0) {
    res.status(403); // 403 Forbidden
    throw new Error("الوصول مرفوض. هذه الميزة تتطلب اشتراكًا نشطًا.");
  }

  // إذا كان المستخدم مشتركًا، اسمح للطلب بالمرور
  next();
});

const verifyProfile = asyncHandler(async (req, res, next) => {
  // هذه الدالة تعمل بعد دالة protect، لذا req.user سيكون موجوداً
  if (req.user && req.user.verification_status === "approved") {
    next(); // المستخدم موثق، اسمح له بالمرور
  } else {
    res.status(403); // 403 Forbidden
    throw new Error("حسابك غير موثق. لا يمكنك الوصول إلى هذه الميزة حاليًا.");
  }
});
// Middleware يسمح بالمرور حتى لو لم يكن المستخدم مسجلاً، ولكنه يرفق المستخدم إذا كان مسجلاً
const optionalProtect = async (req, res, next) => {
  let token;

  // 1. التحقق من الهيدر (Authorization Header) - هذا هو الأساسي
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // جلب بيانات المستخدم
      const [rows] = await pool.query(
        "SELECT id, name, email, role_id, profile_picture_url, verification_status FROM users WHERE id = ?",
        [decoded.id]
      );

      if (rows.length > 0) {
        req.user = rows[0]; // (!!!) إرفاق المستخدم هنا
      }
    } catch (error) {
      // توكن غير صالح، أكمل كزائر
    }
  }
  // 2. التحقق من الكوكيز (كخيار احتياطي)
  else if (req.cookies && req.cookies.token) {
    try {
      token = req.cookies.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const [rows] = await pool.query(
        "SELECT id, name, email, role_id, profile_picture_url, verification_status FROM users WHERE id = ?",
        [decoded.id]
      );

      if (rows.length > 0) {
        req.user = rows[0]; // (!!!) إرفاق المستخدم هنا
      }
    } catch (error) {
      // توكن غير صالح، أكمل كزائر
    }
  }

  // اسمح بالمرور دائماً، سواء كان req.user موجوداً أم لا
  next();
};

const checkPermission = (resource, action = "read") => {
  return (req, res, next) => {
    // 1. السوبر أدمن له كل الصلاحيات
    if (req.user.is_super_admin) {
      return next();
    }

    // 2. جلب الصلاحيات من المستخدم
    const userPermissions = req.user.permissions; // يفترض أن البارسر حولها لـ Object

    // 3. التحقق
    if (!userPermissions || !userPermissions[resource]) {
      res.status(403);
      throw new Error("ليس لديك صلاحية للوصول لهذه الصفحة.");
    }

    const permissionLevel = userPermissions[resource];

    if (permissionLevel === "none") {
      res.status(403);
      throw new Error("غير مصرح.");
    }

    // إذا كان الإجراء "تعديل" (write)، يجب أن تكون الصلاحية write
    if (action === "write" && permissionLevel !== "write") {
      res.status(403);
      throw new Error("لديك صلاحية المشاهدة فقط.");
    }

    next();
  };
};

// The corrected export list
module.exports = {
  protect,
  restrictTo,
  checkSubscription,
  isVerifiedMerchant,
  isVerifiedSupplier,
  isDropshipper,
  verifyProfile,
  requireSubscription,
  optionalProtect,
  checkPermission,
};
