const asyncHandler = require("express-async-handler");
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");
const { createOrderInternal } = require("../controllers/orderController");

/**
 * @desc    Creates a Stripe Checkout session for a specific subscription plan.
 * @route   POST /api/payments/create-subscription-session
 * @access  Private
 */

/**
 * @desc    Creates a Stripe Checkout session for a specific subscription plan.
 */
const createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe)
    return res.status(500).json({ message: "Stripe is not initialized." });

  const { planId } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!planId) {
    return res.status(400).json({ message: "معرف الباقة مطلوب." });
  }

  const [[plan]] = await pool.query(
    "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
    [planId]
  );
  if (!plan) {
    return res
      .status(404)
      .json({ message: "الباقة المحددة غير متوفرة أو غير نشطة." });
  }

  const unitAmount = Math.round(parseFloat(plan.price) * 100);

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
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/subscribe`,
    });
    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe subscription session creation failed:", error);
    res.status(500).json({ message: "فشل في إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    Creates a Stripe Checkout session for Products.
 * @route   POST /api/payments/create-product-checkout
 * @access  Private
 */
const createCheckoutSessionForProducts = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } =
    req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!cartItems || cartItems.length === 0 || !shippingAddressId) {
    return res.status(400).json({
      message: "البيانات غير كاملة: السلة فارغة أو لم يتم تحديد عنوان الشحن.",
    });
  }

  try {
    const line_items = cartItems.map((item) => ({
      price_data: {
        currency: "sar",
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: item.quantity,
    }));

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

    // ✅ FIX: Create a simplified cart with only the essential data
    // This solves the Stripe 500-character metadata limit error.
    const simplifiedCartForMetadata = cartItems.map((item) => ({
      id: item.id, // Variant ID
      productId: item.productId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
    }));

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
        cartItems: JSON.stringify(simplifiedCartForMetadata), // Use the simplified version
      },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel`,
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe product session creation failed:", error);
    res.status(500).json({ message: "فشل في إنشاء جلسة الدفع." });
  }
});

// --- ✨ دالة إنشاء جلسة دفع للاتفاقيات (الكود الذي أضفته صحيح) ---

/**
 * @desc    Creates a Stripe Checkout session for a Service Package Tier.
 * @route   POST /api/payments/create-agreement-checkout-session
 * @access  Private (Merchant)
 */
const createAgreementCheckoutSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  if (!package_tier_id || !product_id || !model_id) {
    return res
      .status(400)
      .json({ message: "Package, product, and model IDs are required." });
  }

  try {
    // ✨ Fetch price and details from the NEW package tables
    const [[tier]] = await pool.query(
      `SELECT pt.price, sp.title as package_title 
             FROM package_tiers pt
             JOIN service_packages sp ON pt.package_id = sp.id
             WHERE pt.id = ?`,
      [package_tier_id]
    );

    if (!tier) {
      return res.status(404).json({ message: "Package tier not found." });
    }

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
              description: `تفويض مبلغ لباقة خدمة من العارضة`,
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
        package_tier_id, // ✨ Pass the correct ID
        product_id,
      },
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/agreesuccess`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/payment/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Error creating agreement checkout session:", error);
    res.status(500).json({ message: "Failed to create checkout session." });
  }
});

/**
 * @desc    Handles incoming webhook notifications from Stripe.
 * @route   POST /api/payments/webhook
 * @access  Public
 */
// linora-platform/backend/controllers/paymentController.js

const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  } // --- ✅ [CORRECTED LOGIC] ---

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { sessionType } = session.metadata;

    console.log(
      `Processing completed session ${session.id} of type: ${sessionType}`
    );

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (sessionType === "subscription") {
        const { userId, planId } = session.metadata;

        // ⚠️ يفضل دائماً أخذ تاريخ البداية والنهاية من Stripe لضمان عدم اختلاف الحساب
        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        const startDate = new Date(subscription.current_period_start * 1000);
        const endDate = new Date(subscription.current_period_end * 1000);

        await connection.query(
          `INSERT INTO user_subscriptions 
            (user_id, status, start_date, end_date, stripe_subscription_id, plan_id)
          VALUES (?, 'active', ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
              status = 'active',
              start_date = VALUES(start_date),
              end_date = VALUES(end_date),
              stripe_subscription_id = VALUES(stripe_subscription_id),
              plan_id = VALUES(plan_id)`,
          [userId, startDate, endDate, session.subscription, planId]
        );

        console.log(`✅ Subscription activated for user ID: ${userId}`);
      } else if (sessionType === "product_purchase") {
        const orderPayload = {
          customerId: Number(session.metadata.userId),
          cartItems: JSON.parse(session.metadata.cartItems),
          shippingAddressId: Number(session.metadata.shippingAddressId),
          shipping_company_id: Number(session.metadata.shipping_company_id),
          shipping_cost: Number(session.metadata.shipping_cost),
          paymentMethod: "card",
          paymentStatus: "paid",
          stripe_session_id: session.id,
        };
        await createOrderInternal(orderPayload, connection); // Pass connection for transaction
        console.log(
          `✅ Order created successfully from Stripe session: ${session.id}`
        );
      } else if (sessionType === "product_promotion") {
        // --- ✨ [NEW] Automatic Promotion Activation Logic ---
        const { productId, tierId, merchantId } = session.metadata;
        const paymentIntentId = session.payment_intent; // 1. Fetch promotion duration

        const [[tier]] = await connection.query(
          "SELECT duration_days FROM promotion_tiers WHERE id = ?",
          [tierId]
        );
        if (!tier)
          throw new Error(`Promotion tier with ID ${tierId} not found.`); // 2. Insert and activate directly
        await connection.query(
        "INSERT INTO product_promotions (product_id, merchant_id, promotion_tier_id, status, stripe_payment_intent_id, start_date, end_date) VALUES (?, ?, ?, 'active', ?, NOW(), NOW() + INTERVAL ? DAY)",
        [productId, merchantId, tierId, paymentIntentId, tier.duration_days]
      );
        console.log(
          `✅ Promotion for product ID ${productId} has been automatically activated for ${tier.duration_days} days.`
        );
      } else if (sessionType === "agreement_authorization") {
        const { merchant_id, model_id, package_tier_id, product_id } =
          session.metadata;
        const paymentIntentId = session.payment_intent;

        await connection.query(
          "INSERT INTO agreements (merchant_id, model_id, package_tier_id, product_id, status, stripe_payment_intent_id) VALUES (?, ?, ?, ?, ?, ?)",
          [
            merchant_id,
            model_id,
            package_tier_id,
            product_id,
            "pending",
            paymentIntentId,
          ]
        );
        console.log(`✅ Agreement created for merchant: ${merchant_id}`);
      }

      await connection.commit();
    } catch (dbError) {
      await connection.rollback();
      console.error(
        `❌ Webhook transaction error for session ${session.id}:`,
        dbError
      );
    } finally {
      connection.release();
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    try {
      await pool.query(
        "UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?",
        [subscription.id]
      );
      console.log(`✅ Subscription cancelled for Sub ID: ${subscription.id}`);
    } catch (dbError) {
      console.error("❌ DB error on subscription cancellation:", dbError);
    }
  }

  res.status(200).send();
});

/**
 * @desc    Cancels a user's subscription at the end of the current period.
 * @route   POST /api/payments/cancel-subscription
 * @access  Private
 */
const cancelSubscription = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id: userId, email: userEmail } = req.user;

  try {
    const [[sub]] = await pool.query(
      "SELECT stripe_subscription_id, end_date FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
      [userId]
    );

    if (!sub || !sub.stripe_subscription_id) {
      return res
        .status(404)
        .json({ message: "لم يتم العثور على اشتراك فعال." });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await sendEmail({
      to: userEmail,
      subject: "تم تأكيد إلغاء تجديد اشتراكك",
      html: `<div dir="rtl"><h3>تم استلام طلبك بإلغاء التجديد</h3><p>ستظل باقتك فعالة حتى تاريخ ${new Date(
        sub.end_date
      ).toLocaleDateString("ar-EG")}.</p></div>`,
    });

    res
      .status(200)
      .json({ message: "سيتم إلغاء اشتراكك في نهاية فترة الفوترة الحالية." });
  } catch (error) {
    console.error("Error cancelling subscription:", error);
    res.status(500).json({ message: "فشل إلغاء الاشتراك." });
  }
});

/**
 * @desc    Create a payment intent for an agreement
 * @route   POST /api/payments/create-agreement-intent
 * @access  Private (Merchant)
 */
const createAgreementPaymentIntent = async (req, res) => {
  const stripe = getStripe();
  const { offer_id } = req.body;
  const merchant_id = req.user.id;

  if (!offer_id) {
    return res.status(400).json({ message: "Offer ID is required" });
  }

  try {
    // 1. جلب سعر العرض من قاعدة البيانات
    const [[offer]] = await pool.query(
      "SELECT price FROM offers WHERE id = ? AND user_id = ?",
      [offer_id, merchant_id]
    );
    if (!offer) {
      return res
        .status(404)
        .json({ message: "Offer not found or does not belong to you." });
    }

    const amountInCents = Math.round(parseFloat(offer.price) * 100);

    // 2. إنشاء نية الدفع في Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar", // أو أي عملة أخرى تستخدمها
      capture_method: "manual", // ✨ أهم خطوة: لحجز المبلغ فقط دون سحبه
      description: `Agreement fee for offer #${offer_id}`,
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
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
};
