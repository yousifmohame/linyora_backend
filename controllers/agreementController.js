// controllers/agreementController.js
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const { getStripe } = require("../config/stripe");

// [POST] إنشاء اتفاق جديد
// [POST] إنشاء اتفاق جديد (نسخة محدثة ومتوافقة)
exports.createAgreement = async (req, res) => {
  // يجب استقبال package_tier_id بدلاً من offer_id
  const { model_id, product_id, package_tier_id, paymentIntentId } = req.body;
  const merchant_id = req.user.id;

  // تم تحديث التحقق من الحقول
  if (!model_id || !product_id || !package_tier_id || !paymentIntentId) {
    return res.status(400).json({ message: "البيانات المطلوبة غير كاملة" });
  }

  try {
    // تم تحديث استعلام INSERT لاستخدام package_tier_id
    const [result] = await pool.query(
      "INSERT INTO agreements (merchant_id, model_id, product_id, package_tier_id, status, stripe_payment_intent_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        merchant_id,
        model_id,
        product_id,
        package_tier_id,
        "pending",
        paymentIntentId,
      ]
    );

    // (إرسال إشعار للمودل)

    res.status(201).json({
      message: "تم إرسال طلب التعاون بنجاح!",
      agreementId: result.insertId,
    });
  } catch (error) {
    console.error("Error creating agreement:", error);
    // في حالة حدوث خطأ هنا، يجب إلغاء نية الدفع في Stripe لتجنب حجز المبلغ
    try {
      const stripe = getStripe();
      await stripe.paymentIntents.cancel(paymentIntentId);
      res
        .status(500)
        .json({ message: "خطأ في إنشاء الاتفاق، تم إلغاء حجز المبلغ." });
    } catch (cancelError) {
      console.error(
        "Error cancelling payment intent after agreement failure:",
        cancelError
      );
      res
        .status(500)
        .json({
          message: "خطأ فادح: فشل إنشاء الاتفاق وفشل إلغاء حجز المبلغ.",
        });
    }
  }
};

// [GET] جلب طلبات التعاون الواردة للعارضة الحالية
/**
 * @desc    Get incoming agreement requests for the current model
 * @route   GET /api/agreements/requests
 * @access  Private (Model/Influencer)
 */
exports.getAgreementRequests = async (req, res) => {
  const model_id = req.user.id;
  try {
    // ✨ Updated query to join with new package tables
    const query = `
            SELECT 
                a.id, 
                a.status, 
                a.created_at,
                merchant.name as merchantName,
                p.name as productName,
                sp.title as packageTitle,
                pt.tier_name as tierName,
                pt.price as tierPrice
            FROM agreements a
            JOIN users merchant ON a.merchant_id = merchant.id
            JOIN products p ON a.product_id = p.id
            JOIN package_tiers pt ON a.package_tier_id = pt.id
            JOIN service_packages sp ON pt.package_id = sp.id
            WHERE a.model_id = ?
            ORDER BY a.created_at DESC;
        `;
    const [requests] = await pool.query(query, [model_id]);
    res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching agreement requests:", error);
    res.status(500).json({ message: "خطأ في جلب طلبات التعاون" });
  }
};

exports.updateAgreementStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const model_id = req.user.id;

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة" });
  }

  const connection = await pool.getConnection();
  let agreementDetailsForEmail; // To hold details for post-commit actions

  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      "UPDATE agreements SET status = ? WHERE id = ? AND model_id = ?",
      [status, id, model_id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      connection.release();
      return res
        .status(404)
        .json({ message: "الطلب غير موجود أو لا تملك صلاحية تعديله" });
    }

    // ✨ Get details for the email using the NEW package structure
    const [details] = await connection.query(
      `SELECT 
                a.merchant_id, a.stripe_payment_intent_id,
                u.email as merchant_email, 
                sp.title as package_title
             FROM agreements a 
             JOIN users u ON a.merchant_id = u.id
             JOIN package_tiers pt ON a.package_tier_id = pt.id
             JOIN service_packages sp ON pt.package_id = sp.id
             WHERE a.id = ?`,
      [id]
    );
    agreementDetailsForEmail = details.length > 0 ? details[0] : null;

    // If rejected, cancel the Stripe payment authorization
    if (
      status === "rejected" &&
      agreementDetailsForEmail?.stripe_payment_intent_id
    ) {
      const stripe = getStripe();
      await stripe.paymentIntents.cancel(
        agreementDetailsForEmail.stripe_payment_intent_id
      );
    }

    // Commit DB changes before slow network operations
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("Error during agreement status transaction:", error);
    return res.status(500).json({ message: "خطأ في تحديث حالة الطلب" });
  } finally {
    connection.release();
  }

  // --- Post-commit actions (Notifications & Email) ---
  try {
    const statusInArabic = status === "accepted" ? "قبول" : "رفض";

    if (agreementDetailsForEmail) {
      const { merchant_id, merchant_email, package_title } =
        agreementDetailsForEmail;
      const notificationMessage = `تم ${statusInArabic} طلب التعاون الخاص بك بخصوص باقة: "${package_title}"`;

      await pool.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
        [
          merchant_id,
          "AGREEMENT_STATUS",
          notificationMessage,
          "/dashboard/agreements",
        ]
      );

      await sendEmail({
        to: merchant_email,
        subject: `تحديث بخصوص طلب التعاون على منصة لينورا`,
        html: `<div dir="rtl"><h3>تحديث حالة طلب التعاون</h3><p>${notificationMessage}</p><p><a href="${process.env.FRONTEND_URL}/dashboard/agreements">اضغط هنا لمراجعة طلباتك</a></p></div>`,
      });
    }

    res.status(200).json({ message: `تم ${statusInArabic} الطلب بنجاح` });
  } catch (postCommitError) {
    console.error(
      "Failed to send notification/email after status update:",
      postCommitError
    );
    res
      .status(200)
      .json({ message: `تم تحديث الطلب، ولكن فشل إرسال الإشعار.` });
  }
};

// (المتطلبات في أعلى الملف: pool, getStripe, sendEmail...)

/**
 * 1. (الموديل) الاستجابة لطلب اتفاق (قبول أو رفض)
 * PENDING -> ACCEPTED أو PENDING -> REJECTED
 */
exports.respondToAgreement = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // "accepted" or "rejected"
  const model_id = req.user.id;

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة" });
  }

  const connection = await pool.getConnection();
  let agreementDetailsForEmail;

  try {
    await connection.beginTransaction();

    // إضافة "AND status = 'pending'" للتحقق من أن الطلب لم يتم التعامل معه مسبقاً
    const [result] = await connection.query(
      "UPDATE agreements SET status = ? WHERE id = ? AND model_id = ? AND status = 'pending'",
      [status, id, model_id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      connection.release();
      return res
        .status(404)
        .json({ message: "الطلب غير موجود، أو لا تملك صلاحية تعديله، أو تم التعامل معه مسبقاً" });
    }

    const [details] = await connection.query(
      `SELECT 
         a.merchant_id, a.stripe_payment_intent_id,
         u.email as merchant_email, 
         sp.title as package_title
       FROM agreements a 
       JOIN users u ON a.merchant_id = u.id
       JOIN package_tiers pt ON a.package_tier_id = pt.id
       JOIN service_packages sp ON pt.package_id = sp.id
       WHERE a.id = ?`,
      [id]
    );
    agreementDetailsForEmail = details.length > 0 ? details[0] : null;

    // منطق Stripe (ممتاز كما هو)
    if (
      status === "rejected" &&
      agreementDetailsForEmail?.stripe_payment_intent_id
    ) {
      const stripe = getStripe();
      await stripe.paymentIntents.cancel(
        agreementDetailsForEmail.stripe_payment_intent_id
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("Error in respondToAgreement:", error);
    return res.status(500).json({ message: "خطأ في تحديث حالة الطلب" });
  } finally {
    connection.release();
  }

  // --- الإشعارات والبريد الإلكتروني (ممتاز كما هو) ---
  try {
    const statusInArabic = status === "accepted" ? "قبول" : "رفض";

    if (agreementDetailsForEmail) {
      const { merchant_id, merchant_email, package_title } =
        agreementDetailsForEmail;
      const notificationMessage = `تم ${statusInArabic} طلب التعاون الخاص بك بخصوص باقة: "${package_title}"`;

      await pool.query(
        "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
        [
          merchant_id,
          "AGREEMENT_STATUS",
          notificationMessage,
          "/dashboard/agreements",
        ]
      );

      await sendEmail({
        to: merchant_email,
        subject: `تحديث بخصوص طلب التعاون على منصة لينورا`,
        html: `<div dir="rtl"><h3>تحديث حالة طلب التعاون</h3><p>${notificationMessage}</p><p><a href="${process.env.FRONTEND_URL}/dashboard/agreements">اضغط هنا لمراجعة طلباتك</a></p></div>`,
      });
    }

    res.status(200).json({ message: `تم ${statusInArabic} الطلب بنجاح` });
  } catch (postCommitError) {
    console.error(
      "Failed to send notification/email after status update:",
      postCommitError
    );
    res
      .status(200)
      .json({ message: `تم تحديث الطلب، ولكن فشل إرسال الإشعار.` });
  }
};

/**
 * 2. (الموديل) بدء تنفيذ الاتفاقية
 * ACCEPTED -> IN_PROGRESS
 */
exports.startAgreementProgress = async (req, res) => {
  const { id } = req.params;
  const model_id = req.user.id;

  try {
    const [result] = await pool.query(
      "UPDATE agreements SET status = 'in_progress' WHERE id = ? AND model_id = ? AND status = 'accepted'",
      [id, model_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "لا يمكن بدء تنفيذ هذا الطلب. (إما غير موجود أو ليس بحالة 'مقبول')" });
    }

    // إرسال إشعار للتاجر (اختياري لكن موصى به)
    // ... (كود إرسال الإشعار) ...

    res.status(200).json({ message: "تم تحديث حالة الطلب إلى 'قيد التنفيذ'" });
  } catch (error) {
    console.error("Error in startAgreementProgress:", error);
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

/**
 * 3. (الموديل) تسليم العمل
 * IN_PROGRESS -> DELIVERED
 */
exports.deliverAgreement = async (req, res) => {
  const { id } = req.params;
  const model_id = req.user.id;
  // يمكنك إضافة req.body.delivery_notes أو req.files إذا كان التسليم يتضمن ملفات
  
  try {
    const [result] = await pool.query(
      "UPDATE agreements SET status = 'delivered' WHERE id = ? AND model_id = ? AND status = 'in_progress'",
      [id, model_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "لا يمكن تسليم هذا الطلب. (إما غير موجود أو ليس 'قيد التنفيذ')" });
    }

    // إرسال إشعار للتاجر بأن الموديل قام بالتسليم
    // ... (كود إرسال الإشعار) ...

    res.status(200).json({ message: "تم تسليم الطلب بنجاح وفي انتظار تأكيد التاجر" });
  } catch (error) {
    console.error("Error in deliverAgreement:", error);
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

// --- ✨ الدالة الجديدة التي تسمح للتاجر بإكمال الاتفاق ✨ ---
/**
 * @desc    Allows a merchant to mark an agreement as complete
 * @route   PUT /api/agreements/:id/complete
 * @access  Private (Merchant)
 */
exports.completeAgreementByMerchant = async (req, res) => {
  const { id: agreementId } = req.params;
  const merchant_id = req.user.id;

  const connection = await pool.getConnection();
  let agreementDetails;

  try {
    await connection.beginTransaction();

    const [[agreement]] = await connection.query(
      "SELECT * FROM agreements WHERE id = ? AND merchant_id = ? FOR UPDATE",
      [agreementId, merchant_id]
    );

    if (!agreement) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "الاتفاق غير موجود أو لا تملكه." });
    }
    if (agreement.status !== "delivered") {
      await connection.rollback();
      return res.status(400).json({
        message: `لا يمكن إكمال هذا الاتفاق لأنه في حالة '${agreement.status}'`,
      });
    }

    await connection.query(
      "UPDATE agreements SET status = 'completed' WHERE id = ?",
      [agreementId]
    );

    // ✨ Updated query to get details from the correct tables
    const [details] = await connection.query(
      `SELECT 
                a.model_id, a.stripe_payment_intent_id,
                pt.price as tierPrice,
                sp.title as packageTitle,
                m.email as merchant_email, 
                mo.email as model_email
            FROM agreements a
            JOIN package_tiers pt ON a.package_tier_id = pt.id
            JOIN service_packages sp ON pt.package_id = sp.id
            JOIN users m ON a.merchant_id = m.id
            JOIN users mo ON a.model_id = mo.id
            WHERE a.id = ?`,
      [agreementId]
    );
    agreementDetails = details[0];

    const { model_id, tierPrice } = agreementDetails;
    const [settings] = await connection.query(
      "SELECT setting_value FROM platform_settings WHERE setting_key = 'agreement_commission_rate'"
    );
    if (settings.length === 0) throw new Error("Commission rate not set.");

    const commissionRate = parseFloat(settings[0].setting_value);
    const netEarnings = tierPrice - (tierPrice * commissionRate) / 100;

    await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, related_entity_type, related_entity_id, description) VALUES (?, ?, 'earning', 'pending_clearance', 'agreement', ?, ?)`,
      [
        model_id,
        netEarnings,
        agreementId,
        `Earnings from agreement: ${agreementDetails.packageTitle}`,
      ]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("Error completing agreement by merchant:", error);
    return res.status(500).json({ message: "فشل في إكمال الاتفاق." });
  } finally {
    connection.release();
  }

  // Post-commit actions
  try {
    if (agreementDetails && agreementDetails.stripe_payment_intent_id) {
      const stripe = getStripe();
      await stripe.paymentIntents.capture(
        agreementDetails.stripe_payment_intent_id
      );
      console.log(
        `Stripe payment captured for intent: ${agreementDetails.stripe_payment_intent_id}`
      );
    }

    const { model_id, model_email, packageTitle } = agreementDetails;
    const notificationMessage = `قام التاجر بتأكيد اكتمال التعاون الخاص بباقة: "${packageTitle}". تم إضافة أرباحك إلى رصيدك المعلق.`;

    await pool.query(
      "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
      [
        model_id,
        "AGREEMENT_COMPLETED",
        notificationMessage,
        "/dashboard/models/wallet",
      ]
    );
    await sendEmail({
      to: model_email,
      subject: `تهانينا! تم إكمال اتفاق "${packageTitle}"`,
      html: `<p>${notificationMessage}</p>`,
    });

    res.status(200).json({ message: "تم تأكيد اكتمال الاتفاق بنجاح." });
  } catch (postCommitError) {
    console.error("Post-commit error (Stripe/Email):", postCommitError);
    res.status(200).json({
      message:
        "تم تأكيد الاتفاق، ولكن حدث خطأ أثناء معالجة الدفع أو الإشعارات.",
    });
  }
};

/**
 * @desc    Get all agreements for the current merchant, adapted for the new package system
 * @route   GET /api/agreements/my-agreements
 * @access  Private (Merchant)
 */
exports.getMerchantAgreements = async (req, res) => {
  const merchant_id = req.user.id;
  try {
    // ✨ Updated query to join with new package tables
    const query = `
            SELECT 
                a.id, 
                a.status, 
                a.created_at,
                model.name as modelName,
                p.name as productName,
                sp.title as packageTitle,
                pt.tier_name as tierName,
                pt.price as tierPrice,
                (SELECT COUNT(*) 
                FROM agreement_reviews ar 
                WHERE ar.agreement_id = a.id AND ar.reviewer_id = a.merchant_id) > 0 AS hasMerchantReviewed
            FROM agreements a
            JOIN users model ON a.model_id = model.id
            JOIN products p ON a.product_id = p.id
            JOIN package_tiers pt ON a.package_tier_id = pt.id
            JOIN service_packages sp ON pt.package_id = sp.id
            WHERE a.merchant_id = ?
            ORDER BY a.created_at DESC;
        `;
    const [agreements] = await pool.query(query, [merchant_id]);
    res.status(200).json(agreements);
  } catch (error) {
    console.error("Error fetching merchant agreements:", error);
    res.status(500).json({ message: "Error fetching your agreements." });
  }
};

// --- ✨ الدالة الجديدة التي تضيف التقييم ---
/**
 * @desc    Create a review for a completed agreement
 * @route   POST /api/agreements/:id/review
 * @access  Private (Merchant, Model, Influencer)
 */
exports.createAgreementReview = async (req, res) => {
  const { id: agreementId } = req.params;
  const { rating, comment } = req.body;
  const reviewerId = req.user.id;

  if (!rating || rating < 1 || rating > 5) {
    return res
      .status(400)
      .json({ message: "الرجاء تقديم تقييم صالح بين 1 و 5." });
  }

  try {
    const [agreementResult] = await pool.query(
      "SELECT merchant_id, model_id, status FROM agreements WHERE id = ?",
      [agreementId]
    );

    if (agreementResult.length === 0) {
      return res.status(404).json({ message: "لم يتم العثور على الاتفاق." });
    }

    const agreement = agreementResult[0];

    const isMerchant = agreement.merchant_id === reviewerId;
    const isModel = agreement.model_id === reviewerId;

    if (!isMerchant && !isModel) {
      return res
        .status(403)
        .json({ message: "لا تملك صلاحية لتقييم هذا الاتفاق." });
    }

    const revieweeId = isMerchant ? agreement.model_id : agreement.merchant_id;

    await pool.query(
      "INSERT INTO agreement_reviews (agreement_id, reviewer_id, reviewee_id, rating, comment) VALUES (?, ?, ?, ?, ?)",
      [agreementId, reviewerId, revieweeId, rating, comment]
    );

    res.status(201).json({ message: "تمت إضافة تقييمك بنجاح. شكراً لك!" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "لقد قمت بتقييم هذا الاتفاق مسبقاً." });
    }
    console.error("Error creating agreement review:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إضافة التقييم." });
  }
};

// @desc    جلب الاتفاقيات النشطة للمؤثرة الحالية مع تفاصيل المنتج
// @route   GET /api/v1/agreements/active-for-user
// @access  Protected (Models, Influencers)
exports.getActiveAgreementsForUser = async (req, res) => {
    const userId = req.user.id; // ID المؤثرة الحالية

    console.log(`--- GetActiveAgreements: Fetching active agreements for User ID: ${userId} ---`);

    try {
        const query = `
            SELECT 
                a.id as agreement_id, 
                a.status as agreement_status, 
                p.id as product_id, 
                p.name as product_name,
                -- جلب صورة المنتج من product_variants
                (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]')) 
                 FROM product_variants pv 
                 WHERE pv.product_id = p.id LIMIT 1) as product_image_url,
                m.id as merchant_id,
                m.store_name as merchant_store_name 
            FROM agreements a
            JOIN products p ON a.product_id = p.id
            JOIN users m ON a.merchant_id = m.id -- للانضمام مع التاجر
            WHERE a.model_id = ? 
              AND a.status IN ('accepted', 'in_progress'); -- أو أي حالات تعتبرها "نشطة" للتنفيذ
        `;

        const [agreements] = await pool.query(query, [userId]);

        console.log(`--- GetActiveAgreements: Found ${agreements.length} active agreements for User ID: ${userId} ---`);
        res.status(200).json(agreements);

    } catch (error) {
        console.error(`--- GetActiveAgreements Error for User ID: ${userId} ---`, error);
        res.status(500).json({ message: 'Server error while fetching active agreements' });
    }
};