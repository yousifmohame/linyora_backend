// controllers/agreementController.js

const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates");
const { getStripe } = require("../config/stripe");

// [POST] إنشاء اتفاق جديد
// ملاحظة: في النظام الجديد، يتم إنشاء الاتفاق غالباً عبر Webhook بعد الدفع.
// ولكن هذه الدالة تظل مفيدة إذا كان النظام يسمح بإنشاء طلبات "بانتظار الدفع" أو لسيناريوهات الويب المباشرة.
exports.createAgreement = async (req, res) => {
  const { model_id, product_id, package_tier_id, paymentIntentId } = req.body;
  const merchant_id = req.user.id;

  if (!model_id || !product_id || !package_tier_id || !paymentIntentId) {
    return res.status(400).json({ message: "البيانات المطلوبة غير كاملة" });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      "INSERT INTO agreements (merchant_id, model_id, product_id, package_tier_id, status, stripe_payment_intent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
      [
        merchant_id,
        model_id,
        product_id,
        package_tier_id,
        "pending",
        paymentIntentId,
      ],
    );

    // جلب التفاصيل للإشعارات
    const [[details]] = await connection.query(
      `
        SELECT 
            m.email as model_email, m.name as model_name,
            u.name as merchant_name,
            sp.title as package_title
        FROM users m
        JOIN users u ON u.id = ?
        JOIN package_tiers pt ON pt.id = ?
        JOIN service_packages sp ON pt.package_id = sp.id
        WHERE m.id = ?
    `,
      [merchant_id, package_tier_id, model_id],
    );

    await connection.commit();

    // --- 🔔 الإشعارات ---
    if (details) {
      await connection.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          model_id,
          "NEW_OFFER",
          "briefcase",
          `عرض تعاون جديد من ${details.merchant_name}`,
          "/dashboard/requests",
        ],
      );

      sendEmail({
        to: details.model_email,
        subject: `عرض تعاون جديد من ${details.merchant_name}`,
        html: templates.newAgreementRequest(
          details.model_name,
          details.merchant_name,
          details.package_title,
        ),
      }).catch(console.error);
    }

    res.status(201).json({
      message: "تم إرسال طلب التعاون بنجاح!",
      agreementId: result.insertId,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error creating agreement:", error);

    // محاولة إلغاء الحجز في حال فشل الحفظ
    try {
      const stripe = getStripe();
      await stripe.paymentIntents.cancel(paymentIntentId);
    } catch (e) {
      console.error("Failed to cancel intent:", e);
    }

    res.status(500).json({ message: "فشل إنشاء الاتفاق." });
  } finally {
    connection.release();
  }
};

/**
 * @desc    Get incoming agreement requests for the current model
 * @route   GET /api/agreements/requests
 * @access  Private (Model/Influencer)
 */
exports.getAgreementRequests = async (req, res) => {
  const model_id = req.user.id;
  try {
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

/**
 * @desc    تحديث حالة الاتفاق (قبول/رفض)
 */
exports.respondToAgreement = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const model_id = req.user.id;

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ message: "حالة غير صالحة" });
  }

  const connection = await pool.getConnection();
  let emailDetails = null;

  try {
    await connection.beginTransaction();

    // 1. تحديث الحالة
    const [result] = await connection.query(
      "UPDATE agreements SET status = ? WHERE id = ? AND model_id = ? AND status = 'pending'",
      [status, id, model_id],
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({ message: "الطلب غير موجود أو تمت معالجته مسبقاً" });
    }

    // 2. جلب البيانات
    const [[details]] = await connection.query(
      `SELECT 
            a.merchant_id, a.stripe_payment_intent_id,
            u.email as merchant_email, u.name as merchant_name,
            m.name as model_name,
            sp.title as package_title
        FROM agreements a 
        JOIN users u ON a.merchant_id = u.id
        JOIN users m ON a.model_id = m.id
        JOIN package_tiers pt ON a.package_tier_id = pt.id
        JOIN service_packages sp ON pt.package_id = sp.id
        WHERE a.id = ?`,
      [id],
    );
    emailDetails = details;

    // 3. إذا رفضت العارضة، نلغي حجز المبلغ ونلغي المعاملات المالية المعلقة
    if (status === "rejected") {
      if (emailDetails?.stripe_payment_intent_id) {
        const stripe = getStripe();
        await stripe.paymentIntents.cancel(
          emailDetails.stripe_payment_intent_id,
        );
      }

      // إلغاء المعاملات المعلقة في المحفظة
      await connection.query(
        "UPDATE wallet_transactions SET status = 'cancelled' WHERE reference_type = 'agreement' AND reference_id = ?",
        [id],
      );
    }

    await connection.commit();

    // --- الإشعارات ---
    if (emailDetails) {
      const statusMsg = status === "accepted" ? "قبول" : "رفض";

      await connection.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          emailDetails.merchant_id,
          "AGREEMENT_UPDATE",
          status === "accepted" ? "check" : "x",
          `تم ${statusMsg} عرض التعاون الخاص بباقة "${emailDetails.package_title}"`,
          "/dashboard/agreements",
        ],
      );

      sendEmail({
        to: emailDetails.merchant_email,
        subject: `تحديث حالة طلب التعاون - ${emailDetails.package_title}`,
        html: templates.agreementStatusUpdate(
          emailDetails.merchant_name,
          emailDetails.model_name,
          status,
          emailDetails.package_title,
        ),
      }).catch(console.error);
    }

    res.status(200).json({
      message: `تم ${status === "accepted" ? "قبول" : "رفض"} الطلب بنجاح`,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error in respondToAgreement:", error);
    res.status(500).json({ message: "خطأ في تحديث الحالة" });
  } finally {
    connection.release();
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
      [id, model_id],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "لا يمكن بدء التنفيذ (الحالة غير صالحة)" });
    }

    const [[info]] = await pool.query(
      `
        SELECT u.id as merchant_id, u.email, u.name as merchant_name, m.name as model_name, sp.title
        FROM agreements a
        JOIN users u ON a.merchant_id = u.id
        JOIN users m ON a.model_id = m.id
        JOIN package_tiers pt ON a.package_tier_id = pt.id
        JOIN service_packages sp ON pt.package_id = sp.id
        WHERE a.id = ?`,
      [id],
    );

    if (info) {
      await pool.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          info.merchant_id,
          "AGREEMENT_UPDATE",
          "clock",
          `بدأ ${info.model_name} العمل على: "${info.title}"`,
          "/dashboard/agreements",
        ],
      );
      sendEmail({
        to: info.email,
        subject: `🚀 بدء العمل - ${info.title}`,
        html: templates.agreementStarted(
          info.merchant_name,
          info.model_name,
          info.title,
        ),
      }).catch(console.error);
    }

    res.status(200).json({ message: "تم تحديث الحالة إلى قيد التنفيذ" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

/**
 * 3. (الموديل) تسليم العمل
 * IN_PROGRESS -> DELIVERED
 */
exports.deliverAgreement = async (req, res) => {
  const { id } = req.params;
  const model_id = req.user.id;

  try {
    const [result] = await pool.query(
      "UPDATE agreements SET status = 'delivered' WHERE id = ? AND model_id = ? AND status = 'in_progress'",
      [id, model_id],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ message: "لا يمكن التسليم (الحالة غير صالحة)" });
    }

    const [[info]] = await pool.query(
      `
        SELECT u.id as merchant_id, u.email, u.name as merchant_name, m.name as model_name, sp.title
        FROM agreements a
        JOIN users u ON a.merchant_id = u.id
        JOIN users m ON a.model_id = m.id
        JOIN package_tiers pt ON a.package_tier_id = pt.id
        JOIN service_packages sp ON pt.package_id = sp.id
        WHERE a.id = ?`,
      [id],
    );

    if (info) {
      await pool.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          info.merchant_id,
          "AGREEMENT_UPDATE",
          "package",
          `قام ${info.model_name} بتسليم العمل لـ "${info.title}". يرجى المراجعة.`,
          "/dashboard/agreements",
        ],
      );
      sendEmail({
        to: info.email,
        subject: `📦 تم تسليم العمل - ${info.title}`,
        html: templates.agreementDelivered(
          info.merchant_name,
          info.model_name,
          info.title,
        ),
      }).catch(console.error);
    }

    res.status(200).json({ message: "تم تسليم العمل بنجاح" });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
};

/**
 * @desc    التاجر يكمل الاتفاق (يحرر الأموال للمودل)
 * @desc    🔥🔥🔥 هذا هو الجزء المحدث ليتوافق مع النظام المالي الجديد
 * @route   PUT /api/agreements/:id/complete
 * @access  Private (Merchant)
 */
exports.completeAgreementByMerchant = async (req, res) => {
  const { id: agreementId } = req.params;
  const merchant_id = req.user.id;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. التحقق من الاتفاق
    const [[agreement]] = await connection.query(
      "SELECT * FROM agreements WHERE id = ? AND merchant_id = ? FOR UPDATE",
      [agreementId, merchant_id],
    );

    if (!agreement) {
      await connection.rollback();
      return res.status(404).json({ message: "الاتفاق غير موجود." });
    }
    if (agreement.status !== "delivered") {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "يجب أن يكون الاتفاق 'تم التسليم' أولاً." });
    }

    // 2. تحديث الحالة في جدول الاتفاقيات
    await connection.query(
      "UPDATE agreements SET status = 'completed' WHERE id = ?",
      [agreementId],
    );

    // 3. 🔥 تحرير الأموال في النظام المالي (Wallet Release)
    // الأموال تم تسجيلها مسبقاً كـ Pending عند إنشاء الاتفاق
    // الآن نحولها إلى Cleared ونحدث الأرصدة

    // جلب المعاملات المعلقة الخاصة بهذا الاتفاق (إيراد + خصم عمولة)
    const [transactions] = await connection.query(
      `SELECT id, wallet_id, amount FROM wallet_transactions 
         WHERE reference_type = 'agreement' AND reference_id = ? AND status = 'pending'`,
      [agreementId],
    );

    if (transactions.length > 0) {
      console.log(
        `💰 Clearing ${transactions.length} transactions for Agreement #${agreementId}`,
      );

      for (const trx of transactions) {
        const amount = Number(trx.amount);

        // 🔥 التصحيح الرياضي هنا:
        // لطرح المبلغ من المعلق، نطرحه كما هو (بإشارته).
        // - إذا كان موجب (+100): pending - 100 (ينقص المعلق)
        // - إذا كان سالب (-10): pending - (-10) => pending + 10 (يرتفع المعلق ليعود للصفر)

        let updateWalletQuery = `UPDATE wallets SET pending_balance = pending_balance - ?`;
        let updateParams = [amount]; // ✅ نرسل المبلغ بإشارته الأصلية (بدون Math.abs)

        if (amount > 0) {
          // إيراد: يزيد الرصيد المتاح وإجمالي الأرباح
          updateWalletQuery += `, balance = balance + ?, total_earnings = total_earnings + ?`;
          updateParams.push(amount, amount);
        } else {
          // خصم: يخصم من الرصيد المتاح (هو سالب، فجمعه يعني خصم)
          updateWalletQuery += `, balance = balance + ?`;
          updateParams.push(amount);
        }

        updateWalletQuery += ` WHERE id = ?`;
        updateParams.push(trx.wallet_id);

        await connection.query(updateWalletQuery, updateParams);

        // تحديث حالة المعاملة
        await connection.query(
          "UPDATE wallet_transactions SET status = 'cleared', available_at = NOW() WHERE id = ?",
          [trx.id],
        );
      }
    } else {
      console.warn(
        `⚠️ No pending transactions found for Agreement #${agreementId}. Maybe manually cleared?`,
      );
    }

    await connection.commit();

    // --- 4. سحب المبلغ فعلياً من Stripe (Capture) ---
    if (agreement.stripe_payment_intent_id) {
      try {
        const stripe = getStripe();
        await stripe.paymentIntents.capture(agreement.stripe_payment_intent_id);
      } catch (stripeError) {
        console.error(
          "⚠️ Stripe Capture Error (Funds released in DB though):",
          stripeError.message,
        );
      }
    }

    // --- 5. الإشعارات ---
    const [[details]] = await pool.query(
      `SELECT m.email, m.name, sp.title 
         FROM agreements a 
         JOIN users m ON a.model_id = m.id
         JOIN package_tiers pt ON a.package_tier_id = pt.id
         JOIN service_packages sp ON pt.package_id = sp.id
         WHERE a.id = ?`,
      [agreementId],
    );

    if (details) {
      await pool.query(
        "INSERT INTO notifications (user_id, type, icon, message, link) VALUES (?, ?, ?, ?, ?)",
        [
          agreement.model_id,
          "AGREEMENT_COMPLETED",
          "dollar-sign",
          `تم إكمال اتفاق "${details.title}" وإيداع الأرباح.`,
          "/dashboard/wallet",
        ],
      );
      sendEmail({
        to: details.email,
        subject: `💰 مبروك! دفعة جديدة من اتفاق "${details.title}"`,
        html: templates.agreementCompleted(
          details.name,
          details.title,
          "المبلغ المودع",
        ),
      }).catch(console.error);
    }

    res.status(200).json({ message: "تم إكمال الاتفاق وتحرير الأرباح بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error completing agreement:", error);
    res.status(500).json({ message: "فشل في إكمال الاتفاق." });
  } finally {
    connection.release();
  }
};

/**
 * @desc    Get all agreements for the current merchant
 */
exports.getMerchantAgreements = async (req, res) => {
  const merchant_id = req.user.id;
  try {
    const query = `
            SELECT 
                a.id, a.status, a.created_at,
                model.name as modelName,
                p.name as productName,
                sp.title as packageTitle,
                pt.tier_name as tierName,
                pt.price as tierPrice,
                (SELECT COUNT(*) FROM agreement_reviews ar WHERE ar.agreement_id = a.id AND ar.reviewer_id = a.merchant_id) > 0 AS hasMerchantReviewed
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
    res.status(500).json({ message: "Error fetching agreements." });
  }
};

/**
 * @desc    Create a review for a completed agreement
 */
exports.createAgreementReview = async (req, res) => {
  const { id: agreementId } = req.params;
  const { rating, comment } = req.body;
  const reviewerId = req.user.id;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "تقييم غير صالح" });
  }

  try {
    const [agreementResult] = await pool.query(
      "SELECT merchant_id, model_id FROM agreements WHERE id = ?",
      [agreementId],
    );

    if (agreementResult.length === 0)
      return res.status(404).json({ message: "الاتفاق غير موجود" });

    const agreement = agreementResult[0];
    const revieweeId =
      agreement.merchant_id === reviewerId
        ? agreement.model_id
        : agreement.merchant_id;

    await pool.query(
      "INSERT INTO agreement_reviews (agreement_id, reviewer_id, reviewee_id, rating, comment) VALUES (?, ?, ?, ?, ?)",
      [agreementId, reviewerId, revieweeId, rating, comment],
    );

    res.status(201).json({ message: "تم إضافة التقييم بنجاح" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return res.status(409).json({ message: "تم التقييم مسبقاً" });
    res.status(500).json({ message: "خطأ في الخادم" });
  }
};

// @desc    جلب الاتفاقيات النشطة للمؤثرة
exports.getActiveAgreementsForUser = async (req, res) => {
  const userId = req.user.id;
  try {
    const query = `
            SELECT 
                a.id as agreement_id, a.status as agreement_status, 
                p.id as product_id, p.name as product_name,
                (SELECT JSON_UNQUOTE(JSON_EXTRACT(pv.images, '$[0]')) FROM product_variants pv WHERE pv.product_id = p.id LIMIT 1) as product_image_url,
                m.id as merchant_id, m.store_name as merchant_store_name 
            FROM agreements a
            JOIN products p ON a.product_id = p.id
            JOIN users m ON a.merchant_id = m.id
            WHERE a.model_id = ? AND a.status IN ('accepted', 'in_progress');
        `;
    const [agreements] = await pool.query(query, [userId]);
    res.status(200).json(agreements);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
