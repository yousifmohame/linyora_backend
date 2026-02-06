const asyncHandler = require("express-async-handler");
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
// تأكد من وجود ملف القوالب أو احذف السطر إذا لم تستخدمه
const templates = require("../utils/emailTemplates"); 
const { getStripe } = require("../config/stripe");
// تأكد من المسار الصحيح للـ Order Controller
const { createOrderInternal } = require("../controllers/orderController");

// =============================================================================
//  🔗 HELPER: SMART URL GENERATOR (مولد الروابط الذكي)
// =============================================================================

/**
 * دالة لتحديد روابط العودة (Success/Cancel) بناءً على المنصة (تطبيق أو ويب)
 * @param {Request} req - كائن الطلب
 * @param {String} type - نوع الجلسة (subscription, product_purchase, agreement, saved_card)
 * @param {String} webSuccessPath - مسار النجاح في الموقع (مثلاً /checkout/success)
 * @param {String} webCancelPath - مسار الإلغاء في الموقع
 */
const getRedirectUrls = (req, type, webSuccessPath, webCancelPath) => {
  // 1. التحقق من الهيدر المرسل من Flutter أو User-Agent
  const isApp = req.headers['x-platform'] === 'app' || 
                (req.headers['user-agent'] && req.headers['user-agent'].includes('LinyoraApp'));

  if (isApp) {
    // 📱 [APP] روابط التطبيق (Deep Links) - تغلق الويب فيو فوراً
    return {
      success_url: `linyora://payment-success?session_id={CHECKOUT_SESSION_ID}&type=${type}`,
      cancel_url: `linyora://payment-cancel`,
    };
  } else {
    // 🌐 [WEB] روابط الموقع العادية
    return {
      success_url: `${process.env.FRONTEND_URL}${webSuccessPath}?session_id={CHECKOUT_SESSION_ID}&type=${type}`,
      cancel_url: `${process.env.FRONTEND_URL}${webCancelPath}`,
    };
  }
};

// =============================================================================
//  CONTROLLERS
// =============================================================================

/**
 * @desc    Creates a Stripe Checkout session for a specific subscription plan.
 * @route   POST /api/payments/create-subscription-session
 */
const createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ message: "Stripe is not initialized." });

  const { planId } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!planId) return res.status(400).json({ message: "معرف الباقة مطلوب." });

  const [[plan]] = await pool.query(
    "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
    [planId]
  );
  if (!plan) return res.status(404).json({ message: "الباقة غير متوفرة." });

  const unitAmount = Math.round(parseFloat(plan.price) * 100);

  // ✅ تحديد الروابط الذكية
  const { success_url, cancel_url } = getRedirectUrls(
    req, 
    'subscription', 
    '/dashboard/payment/success', 
    '/dashboard/subscribe'
  );

  try {
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
              description: plan.description || undefined,
            },
            unit_amount: unitAmount,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId: userId,
        planId: plan.id,
        sessionType: "subscription",
      },
      success_url,
      cancel_url,
    });
    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe subscription error:", error);
    res.status(500).json({ message: "فشل إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    Creates a Stripe Checkout session for Products.
 * @route   POST /api/payments/create-product-checkout
 */
const createCheckoutSessionForProducts = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!cartItems || cartItems.length === 0 || !shippingAddressId) {
    return res.status(400).json({ message: "البيانات غير كاملة." });
  }

  // ✅ تحديد الروابط الذكية
  const { success_url, cancel_url } = getRedirectUrls(
    req, 
    'product_purchase', 
    '/checkout/success', 
    '/checkout/cancel'
  );

  try {
    const line_items = [];
    const verifiedCartItems = [];

    for (const item of cartItems) {
      let variant = null;
      if (item.id) {
         [[variant]] = await pool.query(
          "SELECT id, price, product_id FROM product_variants WHERE id = ?",
          [item.id]
        );
      } else {
         [[variant]] = await pool.query(
            "SELECT id, price, product_id FROM product_variants WHERE product_id = ? LIMIT 1",
            [item.productId]
         );
      }

      if (!variant) throw new Error(`المنتج ${item.id || item.productId} غير موجود.`);

      const [[product]] = await pool.query("SELECT name FROM products WHERE id = ?", [variant.product_id]);
      const productName = product ? product.name : "منتج";
      const realUnitAmount = Math.round(Number(variant.price) * 100);

      line_items.push({
        price_data: {
          currency: "sar",
          product_data: {
            name: `${productName} (${item.name || 'خيار'})`,
            images: item.image ? [item.image] : [],
          },
          unit_amount: realUnitAmount,
        },
        quantity: item.quantity,
      });

      verifiedCartItems.push({
        id: variant.id,
        productId: variant.product_id,
        quantity: item.quantity,
      });
    }

    if (Number(shipping_cost) > 0) {
      line_items.push({
        price_data: {
          currency: "sar",
          product_data: { name: "رسوم الشحن" },
          unit_amount: Math.round(Number(shipping_cost) * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: userEmail,
      line_items,
      metadata: {
        sessionType: "product_purchase",
        userId,
        shippingAddressId,
        shipping_company_id: shipping_company_id || null,
        shipping_cost: shipping_cost || "0",
        cartItems: JSON.stringify(verifiedCartItems),
      },
      success_url,
      cancel_url,
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe product session error:", error);
    res.status(500).json({ message: error.message || "فشل إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    Creates a Stripe Checkout session for Agreements.
 * @route   POST /api/payments/create-agreement-checkout-session
 */
const createAgreementCheckoutSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  if (!package_tier_id || !product_id || !model_id) {
    return res.status(400).json({ message: "البيانات ناقصة." });
  }

  // ✅ تحديد الروابط الذكية
  const { success_url, cancel_url } = getRedirectUrls(
    req, 
    'agreement_authorization', 
    '/dashboard/payment/agreesucces', 
    '/dashboard/payment/cancel'
  );

  try {
    const [[tier]] = await pool.query(
      `SELECT pt.price, sp.title as package_title 
       FROM package_tiers pt
       JOIN service_packages sp ON pt.package_id = sp.id
       WHERE pt.id = ?`,
      [package_tier_id]
    );

    if (!tier) return res.status(404).json({ message: "باقة الخدمة غير موجودة." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      payment_intent_data: {
        capture_method: "manual",
      },
      line_items: [
        {
          price_data: {
            currency: "sar",
            product_data: {
              name: `طلب تعاون: ${tier.package_title}`,
              description: `حجز مبلغ لباقة خدمة (يتم الخصم عند قبول العرض)`,
            },
            unit_amount: Math.round(parseFloat(tier.price) * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        sessionType: "agreement_authorization",
        merchant_id,
        model_id,
        package_tier_id,
        product_id,
      },
      success_url,
      cancel_url,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Agreement session error:", error);
    res.status(500).json({ message: "فشل إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    Create Payment Intent for Saved Cards (Pay directly)
 * @route   POST /api/payments/create-payment-intent
 */
const createPaymentIntent = async (req, res) => {
  const stripe = getStripe();
  
  // ✅ نحتاج success_url فقط هنا كـ return_url في حال 3D Secure
  // لاحظ أننا لا نمرر session_id هنا لأنه ليس checkout session
  const { success_url } = getRedirectUrls(
    req, 
    'saved_card_payment', 
    '/payment/status', 
    '/payment/cancel'
  );

  try {
    const userId = req.user.id;
    const { amount, currency = 'sar', payment_method_id, merchant_id } = req.body;

    const [[user]] = await pool.query("SELECT stripe_customer_id FROM users WHERE id = ?", [userId]);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ message: "العميل غير مسجل في نظام الدفع." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      customer: user.stripe_customer_id,
      payment_method: payment_method_id,
      confirm: true,
      metadata: { merchant_id },
      // ✅ استخدام الرابط الذكي للعودة للتطبيق في حال 3DS
      return_url: success_url, 
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================================================================
//  WEBHOOK HANDLER
// =============================================================================
const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`⚠️ Webhook signature failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { sessionType } = session.metadata;
    console.log(`Processing session ${session.id} type: ${sessionType}`);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (sessionType === "subscription") {
        const { userId, planId } = session.metadata;
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const startDate = new Date(subscription.current_period_start * 1000);
        const endDate = new Date(subscription.current_period_end * 1000);

        await connection.query(
          `INSERT INTO user_subscriptions 
           (user_id, status, start_date, end_date, stripe_subscription_id, plan_id)
           VALUES (?, 'active', ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE status='active', start_date=VALUES(start_date), end_date=VALUES(end_date), stripe_subscription_id=VALUES(stripe_subscription_id), plan_id=VALUES(plan_id)`,
          [userId, startDate, endDate, session.subscription, planId]
        );
      } else if (sessionType === "product_purchase") {
        const orderPayload = {
          customerId: Number(session.metadata.userId),
          cartItems: JSON.parse(session.metadata.cartItems),
          shippingAddressId: Number(session.metadata.shippingAddressId),
          shipping_company_id: session.metadata.shipping_company_id ? Number(session.metadata.shipping_company_id) : null,
          shipping_cost: Number(session.metadata.shipping_cost),
          paymentMethod: "card",
          paymentStatus: "paid",
          stripe_session_id: session.id,
        };
        await createOrderInternal(orderPayload);
      } else if (sessionType === "product_promotion") {
        const { productId, tierId, merchantId } = session.metadata;
        const paymentIntentId = session.payment_intent;
        const [[tier]] = await connection.query("SELECT duration_days FROM promotion_tiers WHERE id = ?", [tierId]);
        if (tier) {
          await connection.query(
            "INSERT INTO product_promotions (product_id, merchant_id, promotion_tier_id, status, stripe_payment_intent_id, start_date, end_date) VALUES (?, ?, ?, 'active', ?, NOW(), NOW() + INTERVAL ? DAY)",
            [productId, merchantId, tierId, paymentIntentId, tier.duration_days]
          );
        }
      } else if (sessionType === "agreement_authorization") {
        const { merchant_id, model_id, package_tier_id, product_id } = session.metadata;
        const paymentIntentId = session.payment_intent;
        await connection.query(
          `INSERT INTO agreements (merchant_id, model_id, package_tier_id, product_id, status, stripe_payment_intent_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
          [merchant_id, model_id, package_tier_id, product_id, paymentIntentId]
        );
      }
      await connection.commit();
    } catch (dbError) {
      await connection.rollback();
      console.error(`❌ Webhook Logic Error:`, dbError);
    } finally {
      connection.release();
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    await pool.query("UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?", [subscription.id]);
  }

  res.status(200).send();
});

// =============================================================================
//  HELPER FUNCTIONS (Saved Cards & Utilities)
// =============================================================================

const getOrCreateCustomer = async (user) => {
  const stripe = getStripe();
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const [[dbUser]] = await pool.query("SELECT stripe_customer_id FROM users WHERE id = ?", [user.id]);
  if (dbUser && dbUser.stripe_customer_id) return dbUser.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id }
  });

  await pool.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?", [customer.id, user.id]);
  return customer.id;
};

const getPaymentMethods = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);
  const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  const customer = await stripe.customers.retrieve(customerId);
  
  res.json(paymentMethods.data.map(pm => ({
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    exp_month: pm.card.exp_month,
    exp_year: pm.card.exp_year,
    is_default: pm.id === customer.invoice_settings.default_payment_method
  })));
});

const createSetupIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });
  res.json({ clientSecret: setupIntent.client_secret });
});

const deletePaymentMethod = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id } = req.params;
  try {
    await stripe.paymentMethods.detach(id);
    res.json({ message: "تم حذف البطاقة بنجاح" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id } = req.params;
  const customerId = await getOrCreateCustomer(req.user);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: id },
  });
  res.json({ message: "تم تحديث البطاقة الافتراضية" });
});

const cancelSubscription = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id: userId, email: userEmail } = req.user;
  try {
    const [[sub]] = await pool.query(
      "SELECT stripe_subscription_id, end_date FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
      [userId]
    );
    if (!sub || !sub.stripe_subscription_id) {
      return res.status(404).json({ message: "لم يتم العثور على اشتراك فعال." });
    }
    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    await sendEmail({
      to: userEmail,
      subject: "تم إلغاء التجديد",
      html: `<div dir="rtl"><h3>تم إلغاء التجديد</h3><p>باقتك فعالة حتى ${new Date(sub.end_date).toLocaleDateString("ar-EG")}.</p></div>`,
    });
    res.status(200).json({ message: "سيتم إلغاء الاشتراك في نهاية الفترة." });
  } catch (error) {
    res.status(500).json({ message: "فشل إلغاء الاشتراك." });
  }
});

const createAgreementPaymentIntent = async (req, res) => {
  const stripe = getStripe();
  const { offer_id } = req.body;
  const merchant_id = req.user.id;
  if (!offer_id) return res.status(400).json({ message: "Offer ID required" });

  try {
    const [[offer]] = await pool.query("SELECT price FROM offers WHERE id = ? AND user_id = ?", [offer_id, merchant_id]);
    if (!offer) return res.status(404).json({ message: "Offer not found." });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(offer.price) * 100),
      currency: "sar",
      capture_method: "manual",
      description: `Agreement fee for offer #${offer_id}`,
    });
    res.status(200).json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    res.status(500).json({ message: "Failed to create payment intent." });
  }
};

module.exports = {
  createSubscriptionSession,
  createCheckoutSessionForProducts,
  handlePaymentWebhook,
  cancelSubscription,
  createAgreementPaymentIntent,
  createAgreementCheckoutSession,
  getPaymentMethods,      // ✨ جديد
  createSetupIntent,      // ✨ جديد
  createPaymentIntent,
  deletePaymentMethod,    // ✨ جديد
  setDefaultPaymentMethod // 
};
