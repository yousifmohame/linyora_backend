// backend/controllers/paymentController.js

const asyncHandler = require("express-async-handler");
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");
const { createOrderInternal } = require("../controllers/orderController");
const { recordTransaction } = require("../controllers/walletController");

// --- Helper Functions ---

const getOrCreateCustomer = async (user) => {
  const stripe = getStripe();
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const [[dbUser]] = await pool.query(
    "SELECT stripe_customer_id FROM users WHERE id = ?",
    [user.id],
  );
  if (dbUser && dbUser.stripe_customer_id) {
    return dbUser.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id },
  });

  await pool.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?", [
    customer.id,
    user.id,
  ]);

  return customer.id;
};

// ==========================================
// 🌐 WEB FLOWS
// ==========================================

const createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { planId } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!planId) return res.status(400).json({ message: "Plan ID required" });

  const [[plan]] = await pool.query(
    "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
    [planId],
  );
  if (!plan) return res.status(404).json({ message: "Plan not found" });

  // إلغاء الاشتراك القديم إن وجد
  const [[activeSub]] = await pool.query(
    "SELECT stripe_subscription_id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
    [userId],
  );

  if (activeSub?.stripe_subscription_id) {
    try {
      console.log(
        `🔄 Cancelling old subscription: ${activeSub.stripe_subscription_id}`,
      );
      await stripe.subscriptions.cancel(activeSub.stripe_subscription_id);
      await pool.query(
        "UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?",
        [activeSub.stripe_subscription_id],
      );
    } catch (e) {
      console.error("Cancel Error:", e.message);
    }
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
            product_data: { name: plan.name, description: plan.description },
            unit_amount: unitAmount,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      // 🔥🔥🔥 هام جداً: الميتاداتا داخل subscription_data 🔥🔥🔥
      subscription_data: {
        metadata: {
          userId: userId,
          planId: plan.id,
          sessionType: "subscription",
        },
      },
      metadata: { userId, planId: plan.id, sessionType: "subscription" }, // للجلسة فقط
      success_url: `${process.env.FRONTEND_URL}/dashboard?subscription_success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/subscribe`,
    });
    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Session Create Error:", error);
    res.status(500).json({ message: "Failed to create session" });
  }
});

const createCheckoutSessionForProducts = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } =
    req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!cartItems || !shippingAddressId)
    return res.status(400).json({ message: "بيانات ناقصة." });

  try {
    const line_items = [];
    const verifiedCartItems = [];

    for (const item of cartItems) {
      const [[variant]] = await pool.query(
        "SELECT id, price, product_id FROM product_variants WHERE id = ?",
        [item.id],
      );
      if (!variant) throw new Error(`Product ${item.id} not found.`);
      const [[product]] = await pool.query(
        "SELECT name FROM products WHERE id = ?",
        [variant.product_id],
      );

      line_items.push({
        price_data: {
          currency: "sar",
          product_data: {
            name: `${product.name} (${item.name})`,
            images: item.image ? [item.image] : [],
          },
          unit_amount: Math.round(Number(variant.price) * 100),
        },
        quantity: item.quantity,
      });

      verifiedCartItems.push({
        id: variant.id,
        productId: variant.product_id,
        price: variant.price,
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
        cartItems: JSON.stringify(
          verifiedCartItems.map((i) => ({
            id: i.id,
            productId: i.productId,
            quantity: i.quantity,
          })),
        ),
      },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel`,
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const createAgreementCheckoutSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  try {
    const [[tier]] = await pool.query(
      `SELECT pt.price, sp.title FROM package_tiers pt JOIN service_packages sp ON pt.package_id = sp.id WHERE pt.id = ?`,
      [package_tier_id],
    );
    if (!tier)
      return res.status(404).json({ message: "Package tier not found." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      payment_intent_data: { capture_method: "manual" }, // حجز المبلغ فقط
      line_items: [
        {
          price_data: {
            currency: "sar",
            product_data: {
              name: `تعاون: ${tier.title}`,
              description: "تفويض مبلغ للخدمة",
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
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/agreesucces`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/payment/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ message: "Failed to create session." });
  }
});

// ==========================================
// 📱 MOBILE FLOWS
// ==========================================

const createMobilePaymentIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } =
    req.body;
  const { id: userId } = req.user;

  if (!cartItems || !shippingAddressId)
    return res.status(400).json({ message: "Data incomplete." });

  try {
    let totalAmount = 0;
    const verifiedCartItems = [];

    for (const item of cartItems) {
      const [[variant]] = await pool.query(
        "SELECT id, price, product_id FROM product_variants WHERE id = ?",
        [item.id],
      );
      if (!variant) throw new Error(`Variant ${item.id} not found.`);
      totalAmount += Number(variant.price) * item.quantity;
      verifiedCartItems.push({
        id: variant.id,
        productId: variant.product_id,
        quantity: item.quantity,
      });
    }

    if (Number(shipping_cost) > 0) totalAmount += Number(shipping_cost);

    const customerId = await getOrCreateCustomer(req.user);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100),
      currency: "sar",
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        sessionType: "product_purchase",
        userId: userId.toString(),
        shippingAddressId: shippingAddressId.toString(),
        shipping_company_id: shipping_company_id
          ? shipping_company_id.toString()
          : "",
        shipping_cost: shipping_cost ? shipping_cost.toString() : "0",
        cartItems: JSON.stringify(verifiedCartItems),
        source: "mobile_app",
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const createMobileSetupIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });
  res.json({ clientSecret: setupIntent.client_secret, customerId });
});

const createMobileSubscription = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { planId, paymentMethodId } = req.body;
  const { id: userId } = req.user;

  try {
    const [[plan]] = await pool.query(
      "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
      [planId],
    );
    if (!plan) return res.status(404).json({ message: "Plan not found." });

    const customerId = await getOrCreateCustomer(req.user);

    let usedPaymentMethodId = paymentMethodId;

    if (paymentMethodId) {
      try {
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: customerId,
        });
      } catch (e) {}
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    } else {
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.invoice_settings.default_payment_method) {
        usedPaymentMethodId = customer.invoice_settings.default_payment_method;
      } else {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: customerId,
          type: "card",
          limit: 1,
        });
        if (paymentMethods.data.length > 0) {
          usedPaymentMethodId = paymentMethods.data[0].id;
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: usedPaymentMethodId },
          });
        } else {
          return res.status(400).json({ message: "No payment method found." });
        }
      }
    }

    const price = await stripe.prices.create({
      unit_amount: Math.round(parseFloat(plan.price) * 100),
      currency: "sar",
      recurring: { interval: "month" },
      product_data: { name: plan.name },
    });

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      metadata: {
        userId,
        planId: plan.id,
        sessionType: "subscription",
        source: "mobile_app",
      },
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
    });

    res.status(200).json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent?.client_secret,
      status: subscription.status,
      paymentMethodId: usedPaymentMethodId,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const createMobileAgreementIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { offer_id, package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  if ((!offer_id && !package_tier_id) || !product_id || !model_id) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    let amountInCents = 0;
    let description = "";

    if (offer_id) {
      const [[offer]] = await pool.query(
        "SELECT price FROM offers WHERE id = ?",
        [offer_id],
      );
      amountInCents = Math.round(parseFloat(offer.price) * 100);
      description = `Agreement Offer #${offer_id}`;
    } else {
      const [[tier]] = await pool.query(
        "SELECT price FROM package_tiers WHERE id = ?",
        [package_tier_id],
      );
      amountInCents = Math.round(parseFloat(tier.price) * 100);
      description = `Agreement Package #${package_tier_id}`;
    }

    const customerId = await getOrCreateCustomer(req.user);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar",
      customer: customerId,
      capture_method: "automatic",
      automatic_payment_methods: { enabled: true },
      description,
      metadata: {
        sessionType: "agreement_authorization",
        merchant_id,
        model_id,
        product_id,
        offer_id: offer_id || null,
        package_tier_id: package_tier_id || null,
        source: "mobile_app",
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create intent." });
  }
});

const createMobilePromotionIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { product_id, tier_id } = req.body;
  const merchant_id = req.user.id;

  try {
    const [[tier]] = await pool.query(
      "SELECT * FROM promotion_tiers WHERE id = ?",
      [tier_id],
    );
    if (!tier) return res.status(404).json({ message: "Tier not found." });

    const amountInCents = Math.round(parseFloat(tier.price) * 100);
    const customerId = await getOrCreateCustomer(req.user);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar",
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        sessionType: "product_promotion",
        merchantId: merchant_id,
        productId: product_id,
        tierId: tier_id,
        source: "mobile_app",
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create promotion payment." });
  }
});

// ==========================================
// 🔗 WEBHOOK HANDLER (مع تسجيل المعاملات المالية)
// ==========================================

const handlePaymentWebhook = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1. معالجة دفع الاشتراكات
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;

    if (invoice.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription,
        );
        const { userId, planId } = subscription.metadata;

        if (userId && planId) {
          const startDate = new Date(subscription.current_period_start * 1000);
          const endDate = new Date(subscription.current_period_end * 1000);
          const amountPaid = invoice.amount_paid / 100;

          const connection = await pool.getConnection();
          try {
            // 1. إدراج/تحديث الاشتراك الجديد ليصبح ACTIVE
            await connection.query(
              `INSERT INTO user_subscriptions 
                    (user_id, status, start_date, end_date, stripe_subscription_id, plan_id)
                   VALUES (?, 'active', ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                      status = 'active', start_date = VALUES(start_date), end_date = VALUES(end_date), stripe_subscription_id = VALUES(stripe_subscription_id), plan_id = VALUES(plan_id)`,
              [userId, startDate, endDate, subscription.id, planId],
            );

            // 🔥🔥 2. خطوة التنظيف (الإضافة الجديدة) 🔥🔥
            // نقوم بإلغاء أي اشتراك آخر لهذا المستخدم في قاعدة البيانات ما عدا الاشتراك الحالي
            // هذا يضمن وجود اشتراك واحد نشط فقط في الداتابيس
            await connection.query(
              "UPDATE user_subscriptions SET status = 'cancelled' WHERE user_id = ? AND stripe_subscription_id != ? AND status = 'active'",
              [userId, subscription.id],
            );
            console.log(`🧹 Cleaned up old subscriptions for User ${userId}`);

            // 3. تسجيل المعاملة المالية
            await recordTransaction(
              {
                userId: userId,
                amount: -amountPaid,
                type: "subscription_payment",
                status: "cleared",
                paymentMethod: "card",
                referenceType: "subscription",
                referenceId: subscription.id,
                description: `دفع رسوم اشتراك باقة #${planId}`,
                availableAt: null,
              },
              connection,
            );
          } catch (dbErr) {
            console.error("❌ Database Error during subscription:", dbErr);
          } finally {
            connection.release();
          }
        } else {
          console.warn("⚠️ Subscription Metadata is missing userId or planId.");
        }
      } catch (err) {
        console.error("❌ Webhook Subscription Logic Error:", err);
      }
    }
    return res.status(200).send();
  }

  // 2. معالجة المدفوعات المباشرة (Intent)
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    console.log(
      "💰 PaymentIntent Succeeded. Metadata:",
      paymentIntent.metadata,
    );

    if (!paymentIntent.invoice && paymentIntent.metadata?.sessionType) {
      await processSuccessfulPayment(paymentIntent, stripe, "payment_intent");
    } else {
      console.log("⚠️ Skipped PaymentIntent: No sessionType or is invoice.");
    }
  }

  // 3. معالجة Web Checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode !== "subscription") {
      await processSuccessfulPayment(session, stripe, "checkout_session");
    }
  }

  // 4. إلغاء الاشتراك
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    await pool.query(
      "UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?",
      [subscription.id],
    );
  }

  res.status(200).send();
});

// --- الدالة الموحدة لمعالجة الدفع وتسجيل الأموال ---
async function processSuccessfulPayment(dataObject, stripe, sourceType) {
  const { sessionType } = dataObject.metadata;
  console.log(`🚀 Starting processSuccessfulPayment for: ${sessionType}`);
  console.log("📋 Metadata Received:", dataObject.metadata);

  const connection = await pool.getConnection();

  // تحديد المبلغ المدفوع (Stripe يرسل المبلغ بأصغر وحدة، نحوله للعملة الأساسية)
  const amountPaid = (dataObject.amount || dataObject.amount_total) / 100;

  try {
    await connection.beginTransaction();

    // 🅰️ ترويج المنتجات (Promotion)
    if (sessionType === "product_promotion") {
      const { productId, tierId, merchantId } = dataObject.metadata;
      const paymentId =
        sourceType === "payment_intent"
          ? dataObject.id
          : dataObject.payment_intent;

      const [[tier]] = await connection.query(
        "SELECT duration_days, price FROM promotion_tiers WHERE id = ?",
        [tierId],
      );
      if (tier) {
        await connection.query(
          `INSERT INTO product_promotions (product_id, merchant_id, promotion_tier_id, status, stripe_payment_intent_id, start_date, end_date) 
                 VALUES (?, ?, ?, 'active', ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
          [productId, merchantId, tierId, paymentId, tier.duration_days],
        );

        // 🔥 تسجيل مالي: خصم رسوم الترويج من التاجر
        await recordTransaction(
          {
            userId: merchantId,
            amount: -amountPaid, // خصم
            type: "promotion_fee",
            status: "cleared", // مدفوع بالبطاقة
            paymentMethod: "card",
            referenceType: "product_promotion",
            referenceId: productId,
            description: `رسوم ترويج منتج #${productId}`,
            availableAt: null,
          },
          connection,
        );
      }
    }

    // 🅱️ شراء المنتجات (Orders)
    else if (sessionType === "product_purchase") {
      const orderPayload = {
        customerId: Number(dataObject.metadata.userId),
        cartItems: JSON.parse(dataObject.metadata.cartItems),
        shippingAddressId: Number(dataObject.metadata.shippingAddressId),
        shipping_company_id: Number(dataObject.metadata.shipping_company_id),
        shipping_cost: Number(dataObject.metadata.shipping_cost),
        paymentMethod: "card",
        paymentStatus: "paid",
        stripe_session_id: dataObject.id,
      };
      // ⚠️ ملاحظة: createOrderInternal تستدعي calculateAndRegisterEarnings داخلياً،
      await createOrderInternal(orderPayload, connection);
    }

    // 🆎 الاتفاقيات (Agreements)
    else if (sessionType === "agreement_authorization") {
      console.log("🤝 Agreement Authorization flow detected.");

      const { merchant_id, model_id, product_id, package_tier_id, offer_id } =
        dataObject.metadata;
      const paymentId =
        sourceType === "payment_intent"
          ? dataObject.id
          : dataObject.payment_intent;

      const safePackageId =
        package_tier_id && package_tier_id !== "null" ? package_tier_id : null;
      const safeOfferId = offer_id && offer_id !== "null" ? offer_id : null;

      console.log("📝 Inserting Agreement into DB...", {
        merchant_id,
        model_id,
        safePackageId,
        safeOfferId,
      });

      // 1. إنشاء سجل الاتفاقية
      const [agreeResult] = await connection.query(
        `INSERT INTO agreements (merchant_id, model_id, package_tier_id, offer_id, product_id, status, stripe_payment_intent_id, created_at) 
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW())`,
        [
          merchant_id,
          model_id,
          safePackageId,
          safeOfferId,
          product_id,
          paymentId,
        ],
      );

      console.log("✅ Agreement Inserted ID:", agreeResult.insertId);

      // 2. 🔥 النظام المالي للاتفاقيات:
      // جلب نسبة العمولة للاتفاقيات
      const [[settings]] = await connection.query(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'commission_rate'",
      );
      const commissionRate = (Number(settings?.setting_value) || 10) / 100;

      const platformFee = amountPaid * commissionRate; // عمولة المنصة

      console.log(
        `💰 Financials: Amount=${amountPaid}, Fee=${platformFee}, ModelNet=${amountPaid - platformFee}`,
      );

      // أ) تسجيل إيراد للمودل (معلق حتى انتهاء العمل)
      // نسجل المبلغ كاملاً، ثم نخصم العمولة
      await recordTransaction(
        {
          userId: model_id,
          amount: amountPaid,
          type: "agreement_income",
          status: "pending", // معلق حتى اكتمال الاتفاقية
          paymentMethod: "system", // النظام هو من يدفع للمودل (المال محجوز لدينا)
          referenceType: "agreement",
          referenceId: agreeResult.insertId,
          description: `إيراد اتفاقية جديد #${agreeResult.insertId}`,
          availableAt: null, // يتحدد عند الانتهاء
        },
        connection,
      );

      // ب) تسجيل خصم عمولة المنصة من المودل
      await recordTransaction(
        {
          userId: model_id,
          amount: -platformFee,
          type: "agreement_fee",
          status: "pending",
          paymentMethod: "system",
          referenceType: "agreement",
          referenceId: agreeResult.insertId,
          description: `خصم عمولة منصة عن اتفاقية #${agreeResult.insertId}`,
          availableAt: null,
        },
        connection,
      );

      // ج) تسجيل الدفع على التاجر (لأغراض الكشف فقط)
      await recordTransaction(
        {
          userId: merchant_id,
          amount: -amountPaid,
          type: "agreement_payment",
          status: "cleared", // تم الخصم من بطاقته فوراً
          paymentMethod: "card",
          referenceType: "agreement",
          referenceId: agreeResult.insertId,
          description: `دفع تكلفة اتفاقية #${agreeResult.insertId}`,
          availableAt: null,
        },
        connection,
      );
    } else {
      console.log("⚠️ Unknown sessionType:", sessionType);
    }

    await connection.commit();
    console.log("🎉 Transaction Committed Successfully.");
  } catch (error) {
    await connection.rollback();
    console.error(`❌ Transaction Error (${sessionType}):`, error);
  } finally {
    connection.release();
  }
}

// ==========================================
// 🛠 SHARED UTILITIES
// ==========================================

const getPaymentMethods = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);

  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
  });

  const customer = await stripe.customers.retrieve(customerId);
  const defaultPaymentMethodId =
    customer.invoice_settings.default_payment_method;

  const methods = paymentMethods.data.map((pm) => ({
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    exp_month: pm.card.exp_month,
    exp_year: pm.card.exp_year,
    is_default: pm.id === defaultPaymentMethodId,
  }));

  res.json(methods);
});

const createSetupIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });

  res.json({ clientSecret: setupIntent.client_secret });
});

const createPaymentIntent = async (req, res) => {
  // Generic Payment Intent creator (Manual)
  const stripe = getStripe();
  try {
    const userId = req.user.id;
    const {
      amount,
      currency = "sar",
      payment_method_id,
      merchant_id,
    } = req.body;

    const [[user]] = await pool.query(
      "SELECT stripe_customer_id FROM users WHERE id = ?",
      [userId],
    );

    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ message: "No Stripe Customer ID found." });
    }

    const customerId = user.stripe_customer_id;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency,
      customer: customerId,
      payment_method: payment_method_id,
      confirm: false,
      metadata: { merchant_id },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id,
    });
  } catch (error) {
    console.error("Stripe Intent Error:", error);
    res.status(500).json({ message: error.message });
  }
};

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
      [userId],
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
        sub.end_date,
      ).toLocaleDateString("ar-EG")}.</p></div>`,
    });

    res.status(200).json({ message: "سيتم إلغاء اشتراكك في نهاية الفترة." });
  } catch (error) {
    console.error("Cancellation Error:", error);
    res.status(500).json({ message: "فشل إلغاء الاشتراك." });
  }
});

const createAgreementPaymentIntent = async (req, res) => {
  const stripe = getStripe();
  const { offer_id } = req.body;
  const merchant_id = req.user.id;

  if (!offer_id) return res.status(400).json({ message: "Offer ID required" });

  try {
    const [[offer]] = await pool.query(
      "SELECT price FROM offers WHERE id = ? AND user_id = ?",
      [offer_id, merchant_id],
    );
    if (!offer) return res.status(404).json({ message: "Offer not found." });

    const amountInCents = Math.round(parseFloat(offer.price) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar",
      capture_method: "manual",
      description: `Agreement fee for offer #${offer_id}`,
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Agreement Payment Intent Error:", error);
    res.status(500).json({ message: "Failed to create payment intent." });
  }
};

module.exports = {
  // Web
  createSubscriptionSession,
  createCheckoutSessionForProducts,
  createAgreementCheckoutSession,

  // Mobile
  createMobilePaymentIntent,
  createMobileSetupIntent,
  createMobileSubscription,
  createMobileAgreementIntent,
  createMobilePromotionIntent,

  // Utilities
  handlePaymentWebhook,
  cancelSubscription,
  getPaymentMethods,
  createSetupIntent,
  createPaymentIntent,
  deletePaymentMethod,
  setDefaultPaymentMethod,
  createAgreementPaymentIntent,
};
