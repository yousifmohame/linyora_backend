const asyncHandler = require("express-async-handler");
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");
const { createOrderInternal } = require("../controllers/orderController");

// --- Helper Functions ---

// وظيفة مساعدة للحصول على أو إنشاء عميل Stripe
const getOrCreateCustomer = async (user) => {
  const stripe = getStripe();

  // 1. إذا كان ID العميل موجوداً في كائن المستخدم
  if (user.stripe_customer_id) return user.stripe_customer_id;

  // 2. التحقق من قاعدة البيانات
  const [[dbUser]] = await pool.query(
    "SELECT stripe_customer_id FROM users WHERE id = ?",
    [user.id],
  );
  if (dbUser && dbUser.stripe_customer_id) {
    return dbUser.stripe_customer_id;
  }

  // 3. إنشاء عميل جديد في Stripe
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id },
  });

  // 4. حفظ ID العميل في قاعدة البيانات
  await pool.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?", [
    customer.id,
    user.id,
  ]);

  return customer.id;
};

// ==========================================
// 🌐 WEB FLOWS (Stripe Checkout)
// ==========================================

/**
 * @desc    [Web] Create Subscription Session
 */
const createSubscriptionSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { planId } = req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!planId) return res.status(400).json({ message: "معرف الباقة مطلوب." });

  const [[plan]] = await pool.query(
    "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
    [planId],
  );

  if (!plan)
    return res
      .status(404)
      .json({ message: "الباقة المحددة غير متوفرة أو غير نشطة." });

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
    console.error("Subscription Session Error:", error);
    res.status(500).json({ message: "فشل في إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    [Web] Create Product Checkout Session
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
    const line_items = [];
    const verifiedCartItems = [];

    for (const item of cartItems) {
      const [[variant]] = await pool.query(
        "SELECT id, price, product_id FROM product_variants WHERE id = ?",
        [item.id],
      );

      if (!variant)
        throw new Error(`المنتج أو الخيار رقم ${item.id} غير موجود.`);

      const [[product]] = await pool.query(
        "SELECT name FROM products WHERE id = ?",
        [variant.product_id],
      );
      const productName = product ? product.name : "منتج";
      const realUnitAmount = Math.round(Number(variant.price) * 100);

      line_items.push({
        price_data: {
          currency: "sar",
          product_data: {
            name: `${productName} (${item.name || "خيار"})`,
            images: item.image ? [item.image] : [],
          },
          unit_amount: realUnitAmount,
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
          verifiedCartItems.map((item) => ({
            id: item.id,
            productId: item.productId,
            quantity: item.quantity,
          })),
        ),
      },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout/cancel`,
    });

    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Product Session Error:", error);
    res
      .status(500)
      .json({ message: error.message || "فشل في إنشاء جلسة الدفع." });
  }
});

/**
 * @desc    [Web] Create Agreement Checkout Session
 */
const createAgreementCheckoutSession = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  if (!package_tier_id || !product_id || !model_id) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    const [[tier]] = await pool.query(
      `SELECT pt.price, sp.title as package_title 
       FROM package_tiers pt
       JOIN service_packages sp ON pt.package_id = sp.id
       WHERE pt.id = ?`,
      [package_tier_id],
    );

    if (!tier)
      return res.status(404).json({ message: "Package tier not found." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      payment_intent_data: { capture_method: "manual" },
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
        package_tier_id,
        product_id,
      },
      success_url: `${process.env.FRONTEND_URL}/dashboard/payment/agreesucces`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/payment/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Agreement Session Error:", error);
    res.status(500).json({ message: "Failed to create checkout session." });
  }
});

// ==========================================
// 📱 MOBILE FLOWS (PaymentIntent / SetupIntent)
// ==========================================

/**
 * @desc    [Mobile] Create PaymentIntent for Products
 */
const createMobilePaymentIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { cartItems, shippingAddressId, shipping_company_id, shipping_cost } =
    req.body;
  const { id: userId, email: userEmail } = req.user;

  if (!cartItems || cartItems.length === 0 || !shippingAddressId) {
    return res
      .status(400)
      .json({ message: "البيانات غير كاملة: السلة فارغة أو العنوان ناقص." });
  }

  try {
    let totalAmount = 0;
    const verifiedCartItems = [];

    for (const item of cartItems) {
      const [[variant]] = await pool.query(
        "SELECT id, price, product_id FROM product_variants WHERE id = ?",
        [item.id],
      );

      if (!variant) throw new Error(`Product variant ${item.id} not found.`);

      const realPrice = Number(variant.price);
      totalAmount += realPrice * item.quantity;

      verifiedCartItems.push({
        id: variant.id,
        productId: variant.product_id,
        price: variant.price,
        quantity: item.quantity,
      });
    }

    if (Number(shipping_cost) > 0) totalAmount += Number(shipping_cost);

    const amountInCents = Math.round(totalAmount * 100);
    const customerId = await getOrCreateCustomer(req.user);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
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
        cartItems: JSON.stringify(
          verifiedCartItems.map((item) => ({
            id: item.id,
            productId: item.productId,
            quantity: item.quantity,
          })),
        ),
        source: "mobile_app",
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (error) {
    console.error("Mobile PaymentIntent Error:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to create payment." });
  }
});

/**
 * @desc    [Mobile] Create SetupIntent (Step 1 for Subscription)
 */
const createMobileSetupIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const customerId = await getOrCreateCustomer(req.user);

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });

  res.json({
    clientSecret: setupIntent.client_secret,
    customerId: customerId,
  });
});

/**
 * @desc    [Mobile] Create Subscription (Step 2 after Setup)
 */
const createMobileSubscription = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  const { planId, paymentMethodId } = req.body;
  const { id: userId } = req.user;

  try {
    const [[plan]] = await pool.query(
      "SELECT * FROM subscription_plans WHERE id = ? AND is_active = 1",
      [planId],
    );
    if (!plan) return res.status(404).json({ message: "الباقة غير موجودة." });

    const customerId = await getOrCreateCustomer(req.user);

    // ربط البطاقة وجعلها افتراضية
    if (paymentMethodId) {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    const unitAmount = Math.round(parseFloat(plan.price) * 100);
    const price = await stripe.prices.create({
      unit_amount: unitAmount,
      currency: "sar",
      recurring: { interval: "month" },
      product_data: { name: plan.name },
    });

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      metadata: {
        userId: userId,
        planId: plan.id,
        sessionType: "subscription",
        source: "mobile_app",
      },
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
      expand: ["latest_invoice.payment_intent"],
    });

    const invoice = subscription.latest_invoice;
    const paymentIntent = invoice.payment_intent;

    res.status(200).json({
      subscriptionId: subscription.id,
      clientSecret: paymentIntent ? paymentIntent.client_secret : null,
      status: subscription.status,
    });
  } catch (error) {
    console.error("Mobile Subscription Error:", error);
    res.status(500).json({ message: "فشل في إنشاء الاشتراك." });
  }
});

/**
 * @desc    [Mobile] Create Agreement PaymentIntent (Supports both Offers and Packages)
 * @route   POST /api/payments/mobile/create-agreement-intent
 * @access  Private (Merchant)
 */
const createMobileAgreementIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  // نستقبل إما عرض خاص (offer_id) أو باقة (package_tier_id)
  const { offer_id, package_tier_id, product_id, model_id } = req.body;
  const merchant_id = req.user.id;

  // التحقق من البيانات الأساسية
  if (!product_id || !model_id) {
     return res.status(400).json({ message: "Product ID and Model ID are required." });
  }
  
  // يجب توفر أحدهما على الأقل
  if (!offer_id && !package_tier_id) {
    return res.status(400).json({ message: "Either Offer ID or Package Tier ID is required." });
  }

  try {
    let amountInCents = 0;
    let description = "";

    // 1. حساب السعر بناءً على نوع الاتفاق
    if (offer_id) {
        // --- حالة العرض الخاص ---
        const [[offer]] = await pool.query(
            "SELECT price FROM offers WHERE id = ?", 
            [offer_id]
        );
        if (!offer) return res.status(404).json({ message: "Offer not found." });
        
        amountInCents = Math.round(parseFloat(offer.price) * 100);
        description = `Agreement for Offer #${offer_id}`;
    } 
    else if (package_tier_id) {
        // --- حالة الباقة ---
        const [[tier]] = await pool.query(
            "SELECT price FROM package_tiers WHERE id = ?", 
            [package_tier_id]
        );
        if (!tier) return res.status(404).json({ message: "Package Tier not found." });

        amountInCents = Math.round(parseFloat(tier.price) * 100);
        description = `Agreement for Package Tier #${package_tier_id}`;
    }

    const customerId = await getOrCreateCustomer(req.user);

    // 2. إنشاء نية الدفع في Stripe (مع الميتاداتا الناقصة)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar",
      customer: customerId,
      capture_method: "manual", // حجز المبلغ
      automatic_payment_methods: { enabled: true },
      description: description,
      // ✅✅✅ هذا هو الجزء الذي كان ينقصك!
      metadata: {
        sessionType: "agreement_authorization", // مفتاح الويب هوك
        merchant_id: merchant_id,
        model_id: model_id,
        product_id: product_id,
        // نرسل القيم أو null كنص ليقبلها Stripe
        offer_id: offer_id ? offer_id : null,
        package_tier_id: package_tier_id ? package_tier_id : null,
        source: "mobile_app"
      },
    });

    res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
    });

  } catch (error) {
    console.error("Error creating agreement intent:", error);
    res.status(500).json({ message: "Failed to create payment intent." });
  }
});

// ==========================================
// 🛠 SHARED UTILITIES (Cards, Cancellation)
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

/**
 * @desc    Creates PaymentIntent for Product Promotion (Mobile Native)
 * @route   POST /api/payments/mobile/create-promotion-intent
 * @access  Private (Merchant)
 */
const createMobilePromotionIntent = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  
  // استقبال البيانات كما يرسلها التطبيق (snake_case أو camelCase حسب الاتفاق)
  // في كود Flutter الذي اعتمدناه، نحن نرسل: product_id و tier_id
  const { product_id, tier_id } = req.body;
  const merchant_id = req.user.id;

  if (!product_id || !tier_id) {
    return res.status(400).json({ message: "Product ID and Tier ID are required." });
  }

  try {
    // 1. التحقق من الباقة والسعر
    const [[tier]] = await pool.query(
      "SELECT * FROM promotion_tiers WHERE id = ? AND is_active = 1",
      [tier_id]
    );

    if (!tier) {
      return res.status(404).json({ message: "Promotion tier not found." });
    }

    // 2. التحقق من أن المنتج يخص التاجر (خطوة أمان مهمة)
    const [[product]] = await pool.query(
      "SELECT id FROM products WHERE id = ? AND merchant_id = ?",
      [product_id, merchant_id]
    );

    if (!product) {
        return res.status(404).json({ message: "Product not found or does not belong to you." });
    }

    // 3. تجهيز العميل والمبلغ
    const amountInCents = Math.round(parseFloat(tier.price) * 100);
    const customerId = await getOrCreateCustomer(req.user);

    // 4. إنشاء PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "sar",
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      // ✅ الميتاداتا هنا هي السحر الذي يجعل الـ Webhook يعمل تلقائياً
      metadata: {
        sessionType: "product_promotion", // نفس النوع الذي ينتظره الـ Webhook
        merchantId: merchant_id,
        productId: product_id,
        tierId: tier_id,
        source: "mobile_app",
      },
    });

    // 5. إرجاع المفتاح للتطبيق
    res.json({
      clientSecret: paymentIntent.client_secret,
      customer: customerId,
    });

  } catch (error) {
    console.error("Mobile Promotion Error:", error);
    res.status(500).json({ message: "Failed to create promotion payment." });
  }
});

// ==========================================
// 🔗 WEBHOOK HANDLER (The Core Logic)
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

  console.log(`🔔 Webhook received: ${event.type}`);

  // 1. معالجة Web Checkout (Web)
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    await processSuccessfulPayment(session, stripe, "checkout_session");
  }

  // 2. معالجة Mobile PaymentIntent (Mobile App)
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;

    // تأكد أن هذا الـ Intent لم يأتي من Web Checkout (لتجنب التكرار)
    // Web Checkout لا يضع metadata مفصلة في الـ intent تلقائياً بنفس الشكل
    if (paymentIntent.metadata && paymentIntent.metadata.sessionType) {
      await processSuccessfulPayment(paymentIntent, stripe, "payment_intent");
    }
  }

  // 3. معالجة تجديد الاشتراكات / الدفع الناجح (Web & Mobile)
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    if (invoice.subscription) {
      console.log(`🔄 Subscription Renewed/Paid: ${invoice.subscription}`);
      // يمكنك هنا تحديث تاريخ الانتهاء في قاعدة البيانات إذا كنت تخزنه
    }
  }

  // 4. إلغاء الاشتراك
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    try {
      await pool.query(
        "UPDATE user_subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = ?",
        [subscription.id],
      );
      console.log(`❌ Subscription Cancelled: ${subscription.id}`);
    } catch (dbError) {
      console.error("DB Error on cancellation:", dbError);
    }
  }

  res.status(200).send();
});

// --- دالة موحدة لمعالجة الدفع الناجح (Web & Mobile) ---
async function processSuccessfulPayment(dataObject, stripe, sourceType) {
  const { sessionType } = dataObject.metadata;
  console.log(`✅ Processing Payment (${sourceType}): ${sessionType}`);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    if (sessionType === "subscription") {
      const { userId, planId } = dataObject.metadata;
      // في حالة Mobile قد لا يكون subscription object موجوداً مباشرة في الـ paymentIntent
      // لكنه موجود في الـ Web Checkout.
      // إذا كان Mobile، عادة نعتمد على invoice.payment_succeeded، لكن سنعالجها هنا إذا توفرت المعلومات

      let subscriptionId = dataObject.subscription;
      let startDate, endDate;

      if (subscriptionId && typeof subscriptionId === "string") {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        startDate = new Date(sub.current_period_start * 1000);
        endDate = new Date(sub.current_period_end * 1000);
      } else {
        // Fallback if needed, though invoice.payment_succeeded is better for subs
        startDate = new Date();
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);
      }

      if (subscriptionId) {
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
          [userId, startDate, endDate, subscriptionId, planId],
        );
      }
    } else if (sessionType === "product_promotion") {
        const { productId, tierId, merchantId } = dataObject.metadata;
        // نستخدم id من الكائن حسب المصدر (payment_intent id أو checkout id)
        const paymentIntentId = sourceType === "payment_intent" ? dataObject.id : dataObject.payment_intent;

        console.log(`🔍 Debug Promotion: Searching for Tier ID: ${tierId}, Product ID: ${productId}`);

        const [[tier]] = await connection.query(
          "SELECT duration_days FROM promotion_tiers WHERE id = ?",
          [tierId]
        );

        if (!tier) {
             throw new Error(`Promotion tier with ID ${tierId} not found.`);
        }

        // ✅ هذا هو الكود الصحيح الذي طلبته (بدون تعديل جدول المنتجات)
        await connection.query(
            `INSERT INTO product_promotions 
             (product_id, merchant_id, promotion_tier_id, status, stripe_payment_intent_id, start_date, end_date) 
             VALUES (?, ?, ?, 'active', ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
            [productId, merchantId, tierId, paymentIntentId, tier.duration_days]
        );

        console.log(`✅ SUCCESS: Product ${productId} promoted for ${tier.duration_days} days.`);
    } else if (sessionType === "product_purchase") {
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
      await createOrderInternal(orderPayload, connection);
      console.log(`📦 Order created for User: ${orderPayload.customerId}`);
    } else if (sessionType === "agreement_authorization") {
        const { merchant_id, model_id, product_id, package_tier_id, offer_id } = dataObject.metadata;
        
        // تحديد ID العملية
        const paymentId = sourceType === "payment_intent" ? dataObject.id : dataObject.payment_intent;

        console.log(`🤝 Processing Agreement: Merchant ${merchant_id} -> Model ${model_id}`);

        // تنظيف القيم (Stripe قد يحول null إلى سلسلة نصية "null" أحياناً)
        const safePackageId = (package_tier_id && package_tier_id !== "null") ? package_tier_id : null;
        const safeOfferId = (offer_id && offer_id !== "null") ? offer_id : null;

        // الحفظ في قاعدة البيانات
        await connection.query(
          `INSERT INTO agreements 
           (merchant_id, model_id, package_tier_id, offer_id, product_id, status, stripe_payment_intent_id, created_at) 
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW())`,
          [
            merchant_id,
            model_id,
            safePackageId, // قد يكون null
            safeOfferId,   // قد يكون null
            product_id,
            paymentId,
          ]
        );
        
        console.log(`✅ Agreement created successfully!`);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error(`❌ Transaction Error (${sessionType}):`, error);
  } finally {
    connection.release();
  }
}

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
