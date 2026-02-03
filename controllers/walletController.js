// backend/controllers/walletController.js
const pool = require("../config/db");
const sendEmail = require("../utils/emailService");
const templates = require("../utils/emailTemplates");

/**
 * @desc    Get comprehensive wallet data for the current merchant
 * @route   GET /api/wallet/my-wallet
 * @access  Private (Merchant)
 */
exports.getMerchantWallet = async (req, res) => {
  const merchantId = req.user.id;
  try {
    const query = `
            SELECT
                -- ✨ التصحيح هنا: نجمع كل المعاملات (أرباح + وسحوبات -) التي حالتها 'cleared' أو 'paid'
                (SELECT COALESCE(SUM(amount), 0) 
                 FROM wallet_transactions 
                 WHERE user_id = ? 
                 AND status IN ('cleared', 'paid')) AS balance,
                 
                -- الرصيد المعلق
                (SELECT COALESCE(SUM(amount), 0) 
                 FROM wallet_transactions 
                 WHERE user_id = ? 
                 AND status = 'pending_clearance') AS pending_clearance
            FROM DUAL;
        `;
    const [[wallet]] = await pool.query(query, [merchantId, merchantId]);

    // حساب إجمالي الأرباح (اختياري للعرض فقط)
    // نجمع فقط المعاملات الموجبة من نوع 'earning'
    const [[earningsData]] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions WHERE user_id = ? AND type = 'earning'",
      [merchantId]
    );

    res.json({
      balance: parseFloat(wallet.balance).toFixed(2),
      pending_clearance: parseFloat(wallet.pending_clearance).toFixed(2),
      total_earnings: parseFloat(earningsData.total).toFixed(2),
    });
  } catch (error) {
    console.error("Error fetching merchant wallet data:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Get a list of all financial transactions for the merchant (Corrected)
 * @route   GET /api/wallet/transactions
 * @access  Private (Merchant)
 */
exports.getWalletTransactions = async (req, res) => {
  const merchantId = req.user.id;
  try {
    // ✅ التصحيح: الجلب مباشرة من جدول المعاملات المالية (المصدر الموحد للبيانات)
    const [transactions] = await pool.query(
      `SELECT 
          id,
          amount,
          type,     -- 'earning' or 'payout'
          status,   -- 'cleared', 'pending', 'pending_clearance', etc.
          description,
          created_at,
          related_entity_id as reference_id
       FROM wallet_transactions 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [merchantId]
    );

    // تنسيق البيانات إذا لزم الأمر لتطابق ما تتوقعه الواجهة الأمامية
    const formattedTransactions = transactions.map(t => ({
      id: t.id,
      amount: parseFloat(t.amount).toFixed(2), // سيظهر السحب بالسالب والأرباح بالموجب تلقائياً
      type: t.type,
      status: t.status,
      description: t.description,
      created_at: t.created_at,
      reference_id: t.reference_id
    }));

    res.json(formattedTransactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ message: "Server error" });
  }
};
/**
 * @desc    Create a new payout request
 * @route   POST /api/wallet/request-payout
 * @access  Private (Merchant)
 */
exports.requestPayout = async (req, res) => {
  const merchantId = req.user.id;
  const merchantName = req.user.name;
  const { amount } = req.body;

  const numericAmount = Number(amount);

  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }

  // Add a minimum payout amount check
  if (numericAmount < 50) {
    return res
      .status(400)
      .json({ message: "الحد الأدنى لطلب السحب هو 50 ريال." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // --- ⭐️ بداية الإضافة: التحقق من الطلبات المعلقة ---
    const [pendingRequests] = await connection.query(
      "SELECT COUNT(*) as count FROM payout_requests WHERE merchant_id = ? AND status = 'pending'",
      [merchantId]
    );

    if (pendingRequests[0].count > 0) {
      await connection.rollback();
      connection.release();
      return res
        .status(400)
        .json({ message: "لديك طلب سحب قيد المراجعة بالفعل." });
    }
    // --- ⭐️ نهاية الإضافة ---

    // (الآن نكمل بالمنطق الذي اقترحناه سابقاً - من wallet_transactions)
    const [[wallet]] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as balance 
       FROM wallet_transactions 
       WHERE user_id = ? AND status = 'cleared' FOR UPDATE`,
      [merchantId]
    );
    const currentBalance = parseFloat(wallet.balance);

    if (currentBalance < numericAmount) {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "رصيدك غير كاف لإتمام عملية السحب." });
    }

    // 1. إنشاء معاملة سحب جديدة (سالبة)
    const [txInsert] = await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, description) 
       VALUES (?, ?, 'payout', 'cleared', ?)`,
      [merchantId, -numericAmount, "طلب سحب قيد المراجعة"]
    );
    const txId = txInsert.insertId;

    // 2. تسجيل طلب السحب للمراجعة الإدارية
    await connection.query(
      "INSERT INTO payout_requests (merchant_id, amount, status, wallet_transaction_id) VALUES (?, ?, 'pending', ?)",
      [merchantId, numericAmount, txId] // 'pending' هو الحالة الافتراضية
    );

    await connection.commit();

    const adminEmail = process.env.ADMIN_EMAIL || "me8999109@gmail.com";

    // ملاحظة: نحتاج اسم التاجر، إذا لم يكن في req.user، يجب جلبه
    let name = req.user.name;
    if (!name) {
      const [[user]] = await pool.query("SELECT name FROM users WHERE id = ?", [
        merchantId,
      ]);
      name = user?.name || "Merchant";
    }

    sendEmail({
      to: adminEmail,
      subject: `طلب سحب جديد من ${name}`,
      html: templates.payoutRequestAdmin(
        name,
        "Merchant",
        numericAmount,
        "New"
      ), // مرر الـ ID إذا توفر
    }).catch(console.error);

    res.status(201).json({ message: "تم إرسال طلب السحب بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error requesting payout:", error);
    res.status(500).json({ message: "حدث خطأ أثناء معالجة طلبك." });
  } finally {
    connection.release();
  }
};

// --- ✨ دوال محفظة المودل/المؤثرة (محدثة بالكامل) ---

/**
 * @desc    Get wallet data for the current model/influencer
 * @route   GET /api/wallet/model/my-wallet
 * @access  Private (Model/Influencer)
 */
exports.getModelWallet = async (req, res) => {
  const userId = req.user.id;
  try {
    // استعلام واحد لجلب كل الأرصدة المطلوبة
    const query = `
      SELECT
        (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'cleared') as balance,
        (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND type = 'earning' AND status = 'pending_clearance') as pending_clearance
      FROM DUAL;
    `;
    const [[wallet]] = await pool.query(query, [userId, userId]);

    res.status(200).json({
      balance: parseFloat(wallet.balance),
      pending_clearance: parseFloat(wallet.pending_clearance),
    });
  } catch (error) {
    console.error("Error fetching model wallet data:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Get all transactions for the current model/influencer
 * @route   GET /api/wallet/model/transactions
 * @access  Private (Model/Influencer)
 */
exports.getModelTransactions = async (req, res) => {
  const userId = req.user.id;
  try {
    // 1. جلب معاملات الأرباح
    const [earnings] = await pool.query(
      `SELECT 
                id, amount, status, description, created_at as date, related_entity_id as reference 
             FROM wallet_transactions 
             WHERE user_id = ? AND type = 'earning'`,
      [userId]
    );
    const earningTransactions = earnings.map((t) => ({
      ...t,
      type: "earning",
    }));

    // 2. جلب معاملات السحب
    const [payouts] = await pool.query(
      `SELECT 
                id, amount, status, 'طلب سحب' as description, created_at as date, id as reference 
             FROM model_payout_requests 
             WHERE user_id = ?`,
      [userId]
    );
    const payoutTransactions = payouts.map((t) => ({ ...t, type: "payout" }));

    // 3. دمج وترتيب جميع المعاملات
    const allTransactions = [
      ...earningTransactions,
      ...payoutTransactions,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.status(200).json(allTransactions);
  } catch (error) {
    console.error("Error fetching model transactions:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Create a new payout request for a model/influencer
 * @route   POST /api/wallet/model/request-payout
 * @access  Private (Model/Influencer)
 */
exports.requestModelPayout = async (req, res) => {
  const userId = req.user.id;
  const { amount } = req.body;
  const numericAmount = Number(amount);

  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }
  if (numericAmount < 50) {
    return res
      .status(400)
      .json({ message: "الحد الأدنى لطلب السحب هو 50 ريال." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // التحقق من الطلبات المعلقة
    const [pendingRequests] = await connection.query(
      "SELECT COUNT(*) as count FROM model_payout_requests WHERE user_id = ? AND status = 'pending'",
      [userId]
    );

    if (pendingRequests[0].count > 0) {
      await connection.rollback();
      connection.release();
      return res
        .status(400)
        .json({ message: "لديك طلب سحب قيد المراجعة بالفعل." });
    }

    // حساب الرصيد المتاح
    const [[wallet]] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as balance 
       FROM wallet_transactions 
       WHERE user_id = ? AND status = 'cleared' FOR UPDATE`,
      [userId]
    );
    const availableBalance = parseFloat(wallet.balance);

    if (availableBalance < numericAmount) {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "رصيدك غير كافٍ لإتمام عملية السحب." });
    }

    // 1. إنشاء معاملة سحب جديدة في wallet_transactions
    const [txInsert] = await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, description) 
       VALUES (?, ?, 'payout', 'cleared', ?)`,
      [userId, -numericAmount, "طلب سحب قيد المراجعة"]
    );
    const txId = txInsert.insertId;

    // 2. تسجيل طلب السحب (التصحيح هنا: تعريف المتغير result)
    const [result] = await connection.query(
      "INSERT INTO model_payout_requests (user_id, amount, status, wallet_transaction_id) VALUES (?, ?, 'pending', ?)",
      [userId, numericAmount, txId]
    );

    await connection.commit();

    // الآن المتغير result معرف ويمكن استخدامه
    sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `طلب سحب جديد من ${req.user.name}`,
      html: templates.payoutRequestAdmin(
        req.user.name,
        "Model",
        numericAmount,
        result.insertId
      ),
    }).catch(console.error);

    res.status(201).json({ message: "تم إرسال طلب السحب بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error requesting model payout:", error);
    res.status(500).json({ message: "حدث خطأ أثناء معالجة طلبك." });
  } finally {
    connection.release();
  }
};
