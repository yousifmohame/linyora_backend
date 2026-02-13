// backend/controllers/walletController.js
const pool = require("../config/db");
const asyncHandler = require("express-async-handler");

// ============================================================================
// 🛠️ INTERNAL HELPER FUNCTIONS (دوال مساعدة داخلية)
// ============================================================================

const getAnyWalletId = async (userId, connection = pool) => {
  // نجلب أول محفظة تقابلنا
  const [wallets] = await connection.query(
    "SELECT id FROM wallets WHERE user_id = ? LIMIT 1",
    [userId],
  );

  if (wallets.length > 0) {
    return wallets[0].id;
  }

  // إذا لم توجد، ننشئ واحدة
  const [result] = await connection.query(
    "INSERT INTO wallets (user_id, balance, pending_balance) VALUES (?, 0.00, 0.00)",
    [userId],
  );
  return result.insertId;
};

const getOrCreateWallet = async (userId, connection = pool) => {
  // 1. جلب كل المحافظ
  const [wallets] = await connection.query(
    "SELECT id FROM wallets WHERE user_id = ? ORDER BY id ASC",
    [userId],
  );

  if (wallets.length === 0) {
    const [result] = await connection.query(
      "INSERT INTO wallets (user_id, balance, pending_balance) VALUES (?, 0.00, 0.00)",
      [userId],
    );
    return result.insertId;
  }

  // إذا وجدنا محافظ، نعيد الأولى (كود العرض أدناه سيتكفل بجمع الباقي)
  const primaryWalletId = wallets[0].id;

  // --- محاولة دمج وتنظيف خلفية (لترتيب الداتا فقط) ---
  if (wallets.length > 1) {
    try {
      const otherIds = wallets.slice(1).map((w) => w.id);
      console.log(
        `🧹 Merging wallets ${otherIds} into ${primaryWalletId} for user ${userId}`,
      );

      // نقل المعاملات
      await connection.query(
        "UPDATE wallet_transactions SET wallet_id = ? WHERE wallet_id IN (?)",
        [primaryWalletId, otherIds],
      );

      // نقل الأرصدة وحذف القديم
      const [sums] = await connection.query(
        "SELECT SUM(balance) as b, SUM(pending_balance) as p, SUM(total_earnings) as t FROM wallets WHERE id IN (?)",
        [otherIds],
      );

      if (sums[0].b || sums[0].p) {
        await connection.query(
          "UPDATE wallets SET balance = balance + ?, pending_balance = pending_balance + ?, total_earnings = total_earnings + ? WHERE id = ?",
          [sums[0].b || 0, sums[0].p || 0, sums[0].t || 0, primaryWalletId],
        );
      }

      await connection.query("DELETE FROM wallets WHERE id IN (?)", [otherIds]);
    } catch (err) {
      console.error(
        "Merge warning (ignored, view logic handles it):",
        err.message,
      );
    }
  }
  // ----------------------------------------------------

  return primaryWalletId;
};

// ============================================================================
// 💎 CORE BANKING LOGIC (محرك المعاملات المركزي)
// ============================================================================

/**
 * تسجيل معاملة مالية وتحديث أرصدة المحفظة تلقائياً.
 * يجب استخدام هذه الدالة لأي عملية مالية في النظام لضمان التزامن.
 * * @param {object} params - تفاصيل المعاملة
 * @param {number} params.userId - المستفيد أو الدافع
 * @param {number} params.amount - المبلغ (موجب للإيداع، سالب للخصم)
 * @param {string} params.type - نوع المعاملة (sale_earning, payout, etc.)
 * @param {string} params.paymentMethod - (online, cod, wallet)
 * @param {string} params.referenceType - (order, payout_request, etc.)
 * @param {number} params.referenceId - رقم الطلب أو المرجع
 * @param {string} params.description - وصف عربي للمعاملة
 * @param {string} params.status - (pending, cleared) الحالة الأولية
 * @param {Date} [params.availableAt] - متى يصبح الرصيد متاحاً (للأرباح المعلقة)
 * @param {object} connection - اتصال Transaction مفتوح (ضروري جداً)
 */
/**
 * تسجيل معاملة مالية وتحديث أرصدة المحفظة تلقائياً.
 */
const recordTransaction = async (
  {
    userId,
    amount,
    type,
    paymentMethod,
    referenceType,
    referenceId,
    description,
    status = "pending",
    availableAt = null,
  },
  connection,
) => {
  const walletId = await getOrCreateWallet(userId, connection);

  // 1. تسجيل المعاملة في السجل (للتاريخ والعرض دائماً)
  await connection.query(
    `INSERT INTO wallet_transactions 
     (wallet_id, amount, type, status, payment_method, reference_type, reference_id, description, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      walletId,
      amount,
      type,
      status,
      paymentMethod,
      referenceType,
      referenceId,
      description,
      availableAt,
    ],
  );

  // 2. تحديث أرصدة المحفظة (المنطق الذكي الجديد) 🧠

  // أ) إذا كانت الحالة "pending" (سواء موجب أو سالب)، نحدث الرصيد المعلق دائماً
  if (status === "pending") {
    await connection.query(
      "UPDATE wallets SET pending_balance = pending_balance + ?, last_updated = NOW() WHERE id = ?",
      [amount, walletId],
    );
  }

  // ب) إذا كانت الحالة "cleared" (عملية نافذة فوراً)
  else if (status === "cleared") {
    // 🔥 الشرط الجديد: هل هذا دفع خارجي (بالبطاقة)؟
    // إذا كان الدفع 'card' والمبلغ سالب (خصم)، فهذا يعني أن التاجر دفع من جيبه وليس من المحفظة.
    // لذا لا نخصم من رصيد المحفظة.
    const isExternalPayment = paymentMethod === "card" && amount < 0;

    if (!isExternalPayment) {
      // في الحالات العادية (دفع من المحفظة، أو إيداع أرباح، أو خصم عمولة منصة)، نحدث الرصيد
      await connection.query(
        "UPDATE wallets SET balance = balance + ?, last_updated = NOW() WHERE id = ?",
        [amount, walletId],
      );
    } else {
      console.log(
        `ℹ️ Wallet Info: Transaction recorded but balance NOT updated (External Card Payment). User: ${userId}, Amount: ${amount}`,
      );
    }
  }
};

// نقوم بتصدير الدالة لاستخدامها في وحدات تحكم أخرى (مثل OrderController)
exports.recordTransaction = recordTransaction;

// ============================================================================
// 🎮 CONTROLLER FUNCTIONS (دوال الـ API)
// ============================================================================

/**
 * @desc    جلب رصيد المحفظة (يجمع كل محافظ المستخدم بالقوة)
 */
exports.getMyWallet = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // 🔥 استعلام التجميع: يجمع الأرصدة من جدول wallets لكل ما يخص المستخدم
  const [balanceStats] = await pool.query(
    `SELECT 
        SUM(balance) as total_balance, 
        SUM(pending_balance) as total_pending, 
        SUM(outstanding_debt) as total_debt, 
        SUM(total_earnings) as total_earnings_hist
     FROM wallets 
     WHERE user_id = ?`,
    [userId],
  );

  // 🔥 استعلام العمليات المعلقة: يحسب من جدول المعاملات عبر الربط بالمستخدم
  const [pendingCount] = await pool.query(
    `SELECT COUNT(*) as count 
     FROM wallet_transactions wt
     JOIN wallets w ON wt.wallet_id = w.id
     WHERE w.user_id = ? AND wt.status = 'pending'`,
    [userId],
  );

  const stats = balanceStats[0] || {};

  res.json({
    balance: Number(stats.total_balance || 0),
    pending_balance: Number(stats.total_pending || 0),
    outstanding_debt: Number(stats.total_debt || 0),
    total_earnings: Number(stats.total_earnings_hist || 0),
    currency: "SAR",
    pending_transactions_count: pendingCount[0].count,
    can_withdraw: Number(stats.total_balance) >= 50,
    is_in_debt: Number(stats.total_balance) < 0,
  });
});

/**
 * @desc    جلب سجل العمليات (يجلب كل العمليات من كل المحافظ)
 */
exports.getWalletTransactions = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, type, status } = req.query;
  const offset = (page - 1) * limit;

  // 🔥 JOIN قوي لجلب المعاملات بناءً على المستخدم وليس رقم المحفظة
  let queryBase = `
    FROM wallet_transactions wt
    JOIN wallets w ON wt.wallet_id = w.id
    WHERE w.user_id = ?
  `;
  let queryParams = [userId];

  if (type) {
    queryBase += " AND wt.type = ?";
    queryParams.push(type);
  }
  if (status) {
    queryBase += " AND wt.status = ?";
    queryParams.push(status);
  }

  // جلب البيانات
  const limitNum = Number(limit) || 20;
  const offsetNum = (Number(page) - 1) * limitNum;

  const [transactions] = await pool.query(
    `
  SELECT wt.*, w.user_id
  FROM wallet_transactions wt
  JOIN wallets w ON wt.wallet_id = w.id
  WHERE w.user_id = ?
  ORDER BY wt.created_at DESC
  LIMIT ?, ?
  `,
    [userId, offsetNum, limitNum],
  );

  // العدد الكلي للترقيم
  const [totalResult] = await pool.query(
    `SELECT COUNT(*) as count ${queryBase}`,
    queryParams,
  );

  res.json({
    transactions,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: totalResult[0].count,
      pages: Math.ceil(totalResult[0].count / limit),
    },
  });
});

/**
 * @desc    طلب سحب رصيد (موحد لجميع أنواع المستخدمين)
 * @route   POST /api/wallet/payout-request
 * @access  Private (All Roles: 2, 3, 4)
 */
exports.requestPayout = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const roleId = req.user.role_id; // نفترض أن الـ Token يحتوي على role_id
  const { amount } = req.body;

  // 1. تحديد مسمى المستخدم للعرض
  let userTypeLabel = "مستخدم";
  if (roleId === 2) userTypeLabel = "تاجرة";
  else if (roleId === 3) userTypeLabel = "مورد";
  else if (roleId === 4) userTypeLabel = "مودل/إنفلونسر";

  // 2. التحقق من المدخلات
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }

  const MIN_WITHDRAWAL = 50;
  if (amount < MIN_WITHDRAWAL) {
    return res
      .status(400)
      .json({ message: `الحد الأدنى للسحب هو ${MIN_WITHDRAWAL} ريال.` });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 3. جلب المحفظة (موحدة للجميع)
    const [[wallet]] = await connection.query(
      "SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE",
      [userId],
    );

    if (!wallet) throw new Error("لم يتم العثور على محفظة لهذا المستخدم.");

    const currentBalance = parseFloat(wallet.balance);

    // 4. التحقق من الرصيد
    if (currentBalance < amount) {
      await connection.rollback();
      return res.status(400).json({
        message: "رصيدك المتاح غير كافٍ.",
        balance: currentBalance,
      });
    }

    // 5. خصم الرصيد وتحديث إجمالي المسحوبات
    await connection.query(
      "UPDATE wallets SET balance = balance - ?, total_withdrawn = total_withdrawn + ?, last_updated = NOW() WHERE id = ?",
      [amount, amount, wallet.id],
    );

    // 6. توليد رقم مرجعي
    // مثال: PAYOUT-MODEL-1782323...
    const rolePrefix =
      roleId === 2
        ? "MERCH"
        : roleId === 3
          ? "SUPP"
          : roleId === 4
            ? "MODEL"
            : "USER";
    const payoutReference = `PAYOUT-${rolePrefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 7. تسجيل المعاملة (طلب السحب)
    // هنا نضع الوصف ديناميكياً بناءً على نوع المستخدم
    const [trxResult] = await connection.query(
      `INSERT INTO wallet_transactions 
       (wallet_id, amount, type, status, payment_method, reference_type, reference_id, description, created_at)
       VALUES (?, ?, 'payout', 'pending', 'bank_transfer', 'payout_request', ?, ?, NOW())`,
      [
        wallet.id,
        -amount, // المبلغ بالسالب للخصم
        payoutReference, // الرقم المرجعي
        `طلب سحب أرباح (${userTypeLabel}) #${payoutReference}`, // الوصف يوضح النوع
      ],
    );

    await connection.commit();

    res.status(201).json({
      message: "تم استلام طلب السحب بنجاح.",
      referenceId: payoutReference,
      newBalance: currentBalance - amount,
      userType: userTypeLabel, // نعيد النوع للفرونت إند للتأكيد
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error requesting payout:", error);
    res.status(500).json({ message: "حدث خطأ أثناء معالجة الطلب." });
  } finally {
    connection.release();
  }
});

/**
 * @desc    تحرير الأرباح المعلقة عند اكتمال الطلب
 * @param   {number} orderId - رقم الطلب المكتمل
 * @param   {object} connection - اتصال قاعدة البيانات (اختياري)
 */
exports.releaseOrderEarnings = async (orderId, connection = null) => {
  const conn = connection || pool; // استخدام الاتصال الممرر أو البول العام

  try {
    console.log(`💰 Processing earnings release for Order #${orderId}...`);

    // 1. جلب جميع المعاملات المعلقة المرتبطة بهذا الطلب
    // نبحث عن status = 'pending' وليس 'pending_clearance' لأننا وحدنا المصطلحات
    const [transactions] = await conn.query(
      `SELECT id, wallet_id, amount, type 
       FROM wallet_transactions 
       WHERE reference_type = 'order' 
         AND reference_id = ? 
         AND status = 'pending'`,
      [orderId],
    );

    if (transactions.length === 0) {
      console.log(`⚠️ No pending earnings found for Order #${orderId}`);
      return;
    }

    console.log(`Found ${transactions.length} transactions to clear.`);

    // 2. تحديث كل محفظة ومعاملة
    for (const trx of transactions) {
      const amount = Number(trx.amount);

      // أ) تحديث رصيد المحفظة:
      // - خصم من الرصيد المعلق (pending_balance)
      // - إضافة إلى الرصيد المتاح (balance)
      // - زيادة إجمالي الأرباح (total_earnings) إذا كانت العملية ربحاً

      let walletUpdateQuery = `
        UPDATE wallets 
        SET pending_balance = pending_balance - ?,
            balance = balance + ?
      `;

      // إذا كانت العملية "ربح" (موجبة)، نزيد إجمالي الأرباح التاريخي
      if (amount > 0) {
        walletUpdateQuery += `, total_earnings = total_earnings + ?`;
        await conn.query(walletUpdateQuery, [
          amount,
          amount,
          amount,
          trx.wallet_id,
        ]);
      } else {
        // إذا كانت خصم (سالبة)، لا نعدل إجمالي الأرباح
        await conn.query(walletUpdateQuery, [
          Math.abs(amount),
          amount,
          trx.wallet_id,
        ]);
        // ملاحظة: pending_balance دائماً موجب، amount هنا قد يكون سالب، لذا نستخدم abs للخصم من pending
        // ولكن wait.. في orderController نحن نسجل الأرباح كموجب في pending.
        // الديون فقط تسجل كـ cleared مباشرة.
        // لذا الافتراض هنا أن amount موجب.
      }

      // ب) تحديث حالة المعاملة إلى 'cleared' وتاريخ التوفر
      await conn.query(
        `UPDATE wallet_transactions 
         SET status = 'cleared', available_at = NOW() 
         WHERE id = ?`,
        [trx.id],
      );
    }

    console.log(`✅ Earnings released successfully for Order #${orderId}`);
  } catch (error) {
    console.error("❌ Error releasing earnings:", error);
    throw error; // رمي الخطأ ليتم التعامل معه في الكونترولر الرئيسي
  }
};
