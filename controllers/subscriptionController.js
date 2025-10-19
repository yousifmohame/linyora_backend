// linora-platform/backend/controllers/subscriptionController.js

const pool = require("../config/db");
const asyncHandler = require("express-async-handler");
const { getStripe } = require("../config/stripe");

/**
 * @desc    Get active subscription plans for the logged-in user's role
 * @route   GET /api/subscriptions/plans
 * @access  Private
 */
exports.getSubscriptionPlansForRole = asyncHandler(async (req, res) => {
  // --- ✨ الجزء الذي تم تعديله ---

  // 1. تعريف مصفوفة لترجمة رقم الدور إلى اسم
  const roleMap = {
    2: "merchant",
    3: "model",
    4: "influencer",
  };

  // 2. الحصول على اسم الدور النصي من رقم الدور الخاص بالمستخدم
  const userRole = roleMap[req.user.role_id];

  if (!userRole) {
    // إذا كان الدور غير معروف، أرجع مصفوفة فارغة
    return res.json([]);
  }
  // --- نهاية الجزء المعدل ---

  const [plans] = await pool.query(
    // 3. استخدام اسم الدور الصحيح في الاستعلام
    "SELECT id, name, description, price, features, includes_dropshipping FROM subscription_plans WHERE role = ? AND is_active = TRUE ORDER BY price ASC",
    [userRole]
  );

  const formattedPlans = plans.map((plan) => ({
    ...plan,
    features:
      typeof plan.features === "string"
        ? JSON.parse(plan.features)
        : plan.features || [],
  }));

  res.json(formattedPlans);
});

/**
 * @desc    Create a Stripe checkout session for a selected subscription plan
 * @route   POST /api/subscriptions/create-session
 * @access  Private
 */
exports.createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe)
    return res.status(500).json({ message: "Stripe is not initialized." });

  const { planId } = req.body;
  const { id: userId, email: userEmail } = req.user;

  const [[plan]] = await pool.query(
    "SELECT * FROM subscription_plans WHERE id = ? AND is_active = TRUE",
    [planId]
  );
  if (!plan) {
    return res
      .status(404)
      .json({ message: "لم يتم العثور على باقة الاشتراك." });
  }

  const unitAmount = Math.round(parseFloat(plan.price) * 100);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer_email: userEmail,
    line_items: [
      {
        price_data: {
          currency: "sar",
          product_data: {
            name: plan.name,
            description: plan.description,
          },
          unit_amount: unitAmount,
          recurring: { interval: "month" },
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId: userId,
      planId: plan.id, //  إضافة planId للبيانات الوصفية
      sessionType: "subscription",
    },
    success_url: `${process.env.FRONTEND_URL}/dashboard?subscription_success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard/subscribe`,
  });

  res.status(200).json({ checkoutUrl: session.url });
});

/**
 * @desc    Get the current user's active subscription status and full details
 * @route   GET /api/subscriptions/status
 * @access  Private
 */
exports.getSubscriptionStatus = asyncHandler(async (req, res) => {
  console.log(`🔎 [GET /api/subscriptions/status] Checking active subscription for user: ${req.user.id}`);

  // This query is designed to find ONLY the single, currently active subscription.
  const query = `
    SELECT 
        s.id,
        s.status, 
        s.start_date,
        s.end_date, 
        sp.name AS plan_name,
        sp.description AS plan_description,
        sp.price AS plan_price,
        sp.features AS plan_features,
        sp.includes_dropshipping
    FROM user_subscriptions s
    JOIN subscription_plans sp ON s.plan_id = sp.id
    WHERE s.user_id = ?
      AND s.status = 'active'
      AND NOW() BETWEEN s.start_date AND s.end_date
    ORDER BY s.start_date DESC
    LIMIT 1;
  `;

  const [subscriptions] = await pool.query(query, [req.user.id]);

  if (subscriptions.length > 0) {
    const activeSub = subscriptions[0];
    console.log("✅ Active subscription found:", activeSub.plan_name);
    
    // Parse features from JSON string to an array for the frontend
    const features = typeof activeSub.plan_features === 'string' 
      ? JSON.parse(activeSub.plan_features) 
      : [];

    res.status(200).json({
      status: "active",
      plan: {
        name: activeSub.plan_name,
        description: activeSub.plan_description,
        price: activeSub.plan_price,
        features: features,
      },
      permissions: {
        hasDropshippingAccess: !!activeSub.includes_dropshipping,
      },
      startDate: activeSub.start_date,
      endDate: activeSub.end_date,
    });
  } else {
    console.log(`⚠️ No active subscriptions found for user: ${req.user.id}`);
    res.status(200).json({
      status: "inactive",
      plan: null,
      permissions: {
        hasDropshippingAccess: false,
      },
    });
  }
});


/**
 * @desc    Get all subscriptions for the current user (history)
 * @route   GET /api/subscriptions/history
 * @access  Private
 */
exports.getSubscriptionHistory = asyncHandler(async (req, res) => {
  console.log(`📜 [GET /api/subscriptions/history] Fetching history for user ID: ${req.user.id}`);

  const [subscriptions] = await pool.query(
    `SELECT 
        s.id,
        s.status,
        s.start_date,
        s.end_date,
        sp.name AS plan_name,
        sp.price
     FROM user_subscriptions s
     JOIN subscription_plans sp ON s.plan_id = sp.id
     WHERE s.user_id = ?
     ORDER BY s.start_date DESC`,
    [req.user.id]
  );

  console.log(`📦 Found ${subscriptions.length} subscription records.`);
  res.json(subscriptions);
});



/**
 * @desc    Get all subscriptions for the current user (history)
 * @route   GET /api/subscriptions/history
 * @access  Private
 */
exports.getAllUserSubscriptions = asyncHandler(async (req, res) => {
    const [subscriptions] = await pool.query(
        `SELECT 
            s.id,
            s.status,
            s.start_date,
            s.end_date,
            sp.name AS plan_name,
            sp.price
         FROM user_subscriptions s
         JOIN subscription_plans sp ON s.plan_id = sp.id
         WHERE s.user_id = ?
         ORDER BY s.start_date DESC`,
        [req.user.id]
    );

    res.json(subscriptions);
});