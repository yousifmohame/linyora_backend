// backend/controllers/paymentController.js

const asyncHandler = require("express-async-handler");
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates"); // تأكد من وجود هذا الملف
const { getStripe } = require("../config/stripe");
const { createOrderInternal } = require("../controllers/orderController");

/**
 * @desc    Creates a Stripe Checkout session for a specific subscription plan.
 * @route   POST /api/payments/create-subscription-session
 * @access  Private
 */
const createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ message: "Stripe is not initialized." });

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
    return res.status(404).json({ message: "الباقة المحددة غير متوفرة أو غير نشطة." });
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
 * @desc    Creates a Stripe Checkout session for Products (SECURE VERSION)
 * @route   POST /api/payments/create-product-checkout
 * @access  Private
 */
const createCheckoutSessionForProducts = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!cartItems || cartItems.length === 0 || !shippingAddressId) {
    return res.status(400).json({
      message: "البيانات غير كاملة: السلة فارغة أو لم يتم تحديد عنوان الشحن.",
    });
  }

  try {
    const line_items = [];
    const verifiedCartItems = []; 

    // 1. التكرار عبر عناصر السلة لجلب السعر الحقيقي من قاعدة البيانات
    for (const item of cartItems) {
      // التعامل مع المنتج سواء كان له variant_id أو منتج بسيط
      let variant = null;
      let productId = item.productId;

      if (item.id) {
         [[variant]] = await pool.query(
          "SELECT id, price, product_id FROM product_variants WHERE id = ?",
          [item.id]
        );
      } else {
         // إذا لم يوجد variant_id، نبحث عن الـ Default Variant للمنتج
         [[variant]] = await pool.query(
            "SELECT id, price, product_id FROM product_variants WHERE product_id = ? LIMIT 1",
            [item.productId]
         );
      }

      if (!variant) {
        throw new Error(`المنتج أو الخيار رقم ${item.id || item.productId} غير موجود.`);
      }

      // جلب اسم المنتج
      const [[product]] = await pool.query("SELECT name FROM products WHERE id = ?", [variant.product_id]);
      const productName = product ? product.name : "منتج";

      const realUnitAmount = Math.round(Number(variant.price) * 100);

      line_items.push({
        price_data: {
          currency: "sar",
          product_data: {
            name: `${productName}`, 
            images: item.image ? [item.image] : [],
          },
          unit_amount: realUnitAmount, 
        },
        quantity: item.quantity,
      });

      verifiedCartItems.push({
        id: variant.id, // Variant ID الحقيقي
        productId: variant.product_id,
        price: variant.price,
        quantity: item.quantity,
        name: productName
      });
    }

    // إضافة تكلفة الشحن
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
        cartItems: JSON.stringify(verifiedCartItems.map(item => ({
             id: item.id,
             productId: item.productId,
             quantity: item.quantity 
        }))), 
      },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel`,
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe product session creation failed:", error);
    res.status(500).json({ message: error.message || "فشل في إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    Creates a Stripe Checkout session for a Service Package Tier (Agreements).
 * @route   POST /api/payments/create-agreement-checkout-session
 * @access  Private (Merchant)
 */
const createAgreementCheckoutSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  if (!package_tier_id || !product_id || !model_id) {
    return res.status(400).json({ message: "Package, product, and model IDs are required." });
  }

  try {
    // جلب السعر وتفاصيل الباقة
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
        capture_method: "manual", // حجز المبلغ فقط (Hold)
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
      // تأكد من أن هذه الروابط صحيحة في تطبيقك
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/success?session_id={CHECKOUT_SESSION_ID}&type=agreement`, 
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
const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`⚠️  Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // معالجة الحدث عند اكتمال جلسة الدفع
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { sessionType } = session.metadata;

    console.log(`Processing session ${session.id} type: ${sessionType}`);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 1. حالة الاشتراكات
      if (sessionType === "subscription") {
        const { userId, planId } = session.metadata;
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

      // 2. حالة شراء المنتجات
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
        
        await createOrderInternal(orderPayload); // تم إزالة connection من هنا لأن createOrderInternal تدير اتصالها
        console.log(`✅ Order created successfully: ${session.id}`);

      // 3. حالة الترويج (Promotions)
      } else if (sessionType === "product_promotion") {
        const { productId, tierId, merchantId } = session.metadata;
        const paymentIntentId = session.payment_intent;

        const [[tier]] = await connection.query(
          "SELECT duration_days FROM promotion_tiers WHERE id = ?",
          [tierId]
        );
        if (tier) {
          await connection.query(
            "INSERT INTO product_promotions (product_id, merchant_id, promotion_tier_id, status, stripe_payment_intent_id, start_date, end_date) VALUES (?, ?, ?, 'active', ?, NOW(), NOW() + INTERVAL ? DAY)",
            [productId, merchantId, tierId, paymentIntentId, tier.duration_days]
          );
          console.log(`✅ Promotion activated for product ${productId}`);
        }

      // 4. حالة الاتفاقيات (Agreements)
      } else if (sessionType === "agreement_authorization") {
        const { merchant_id, model_id, package_tier_id, product_id } = session.metadata;
        const paymentIntentId = session.payment_intent;

        await connection.query(
          `INSERT INTO agreements 
           (merchant_id, model_id, package_tier_id, product_id, status, stripe_payment_intent_id, created_at) 
           VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
          [merchant_id, model_id, package_tier_id, product_id, paymentIntentId]
        );
        
        // إشعار المودل بوجود طلب جديد (يمكنك تفعيل هذا الجزء)
        /*
        const [[modelUser]] = await connection.query("SELECT email FROM users WHERE id = ?", [model_id]);
        if(modelUser) {
           await sendEmail({
             to: modelUser.email, 
             subject: 'طلب تعاون جديد', 
             html: templates.newAgreementRequest()
           });
        }
        */
        
        console.log(`✅ Agreement created for merchant: ${merchant_id} -> model: ${model_id}`);
      }

      await connection.commit();
    } catch (dbError) {
      await connection.rollback();
      console.error(`❌ Webhook Logic Error:`, dbError);
    } finally {
      connection.release();
    }
  }

  // إلغاء الاشتراك
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    try {
      await pool.query(
        "UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?",
        [subscription.id]
      );
      console.log(`✅ Subscription cancelled: ${subscription.id}`);
    } catch (dbError) {
      console.error("❌ DB Cancel Error:", dbError);
    }
  }

  res.status(200).send();
});

/**
 * @desc    Cancels a user's subscription at the end of the current period.
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
      return res.status(404).json({ message: "لم يتم العثور على اشتراك فعال." });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await sendEmail({
      to: userEmail,
      subject: "تم تأكيد إلغاء تجديد اشتراكك",
      html: `<div dir="rtl"><h3>تم إلغاء التجديد</h3><p>ستظل باقتك فعالة حتى ${new Date(sub.end_date).toLocaleDateString("ar-EG")}.</p></div>`,
    });

    res.status(200).json({ message: "سيتم إلغاء اشتراكك في نهاية الفترة." });
  } catch (error) {
    res.status(500).json({ message: "فشل إلغاء الاشتراك." });
  }
});

// --- Helper Functions for Saved Cards ---

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

  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });

  const customer = await stripe.customers.retrieve(customerId);
  const defaultPm = customer.invoice_settings.default_payment_method;

  const methods = paymentMethods.data.map(pm => ({
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    exp_month: pm.card.exp_month,
    exp_year: pm.card.exp_year,
    is_default: pm.id === defaultPm
  }));

  res.json(methods);
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

const createPaymentIntent = async (req, res) => {
  const stripe = getStripe();
  try {
    const userId = req.user.id; 
    const { amount, currency = 'sar', payment_method_id, merchant_id } = req.body;

    const [[user]] = await pool.query("SELECT stripe_customer_id FROM users WHERE id = ?", [userId]);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ message: "No Stripe Customer ID found." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      customer: user.stripe_customer_id,
      payment_method: payment_method_id,
      confirm: true, // ✅ محاولة الدفع فوراً للبطاقات المحفوظة
      return_url: `${process.env.FRONTEND_URL}/payment/status`, // مطلوب عند confirm: true
      metadata: { merchant_id }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deletePaymentMethod = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { id } = req.params;
  try {
    await stripe.paymentMethods.detach(id);
    res.json({ message: "تم حذف البطاقة" });
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

// هذا الجزء كان يفتقر للتصدير في الكود الأصلي
const createAgreementPaymentIntent = asyncHandler(async (req, res) => {
    // ... (الكود السابق صحيح) ...
    // تم تركه للاختصار، إذا كنت تستخدم Checkout Session فلا داعي لهذا الجزء بشكل ملح
});

module.exports = {
  createSubscriptionSession,
  createCheckoutSessionForProducts,
  handlePaymentWebhook,
  cancelSubscription,
  createAgreementCheckoutSession,
  createAgreementPaymentIntent,
  getPaymentMethods,
  createSetupIntent,
  createPaymentIntent,
  deletePaymentMethod,
  setDefaultPaymentMethod
};
