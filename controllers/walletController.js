// backend/controllers/walletController.js
const pool = require("../config/db");

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
                -- الرصيد القابل للسحب هو مجموع الأرباح المكتملة
                (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'cleared' AND type = 'earning') AS balance,
                -- الرصيد المعلق هو مجموع الأرباح التي لم تكتمل بعد
                (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND status = 'pending_clearance') AS pending_clearance
            FROM DUAL;
        `;
    const [[wallet]] = await pool.query(query, [merchantId, merchantId]);

    // يمكنك إضافة منطق إجمالي الأرباح وعمليات السحب السابقة بنفس الطريقة
    const [[payouts]] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total_paid FROM payout_requests WHERE merchant_id = ? AND status = 'approved'",
      [merchantId]
    );
    const totalPaid = parseFloat(payouts.total_paid);
    const totalEarnings =
      parseFloat(wallet.balance) +
      parseFloat(wallet.pending_clearance) +
      totalPaid;

    res.json({
      balance: parseFloat(wallet.balance).toFixed(2),
      pending_clearance: parseFloat(wallet.pending_clearance).toFixed(2),
      total_earnings: totalEarnings.toFixed(2),
    });
  } catch (error) {
    console.error("Error fetching merchant wallet data:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Get a list of all financial transactions for the merchant
 * @route   GET /api/wallet/transactions
 * @access  Private (Merchant)
 */
exports.getWalletTransactions = async (req, res) => {
  const merchantId = req.user.id;
  try {
    // 1. Fetch all payout requests (withdrawals)
    const [payouts] = await pool.query(
      "SELECT id, amount, status, created_at FROM payout_requests WHERE merchant_id = ? ORDER BY created_at DESC",
      [merchantId]
    );
    const payoutTransactions = payouts.map((p) => ({
      id: `p-${p.id}`,
      amount: p.amount,
      type: "payout",
      status: p.status,
      description: `طلب سحب #${p.id}`,
      created_at: p.created_at,
      reference_id: p.id,
    }));

    // 2. Fetch all completed orders to represent them as earnings
    const [earnings] = await pool.query(
      `SELECT 
                o.id, 
                o.created_at,
                o.total_amount,
                o.shipping_cost,
                (SELECT SUM(oi.price * oi.quantity) FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = o.id AND p.merchant_id = ?) as merchant_product_total
              FROM orders o
              WHERE o.id IN (SELECT DISTINCT order_id FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE p.merchant_id = ?) 
              AND o.status = 'completed'`,
      [merchantId, merchantId]
    );

    const [settings] = await pool.query(
      "SELECT * FROM platform_settings WHERE setting_key IN ('commission_rate')"
    );
    const commissionRate =
      parseFloat(
        settings.find((s) => s.setting_key === "commission_rate")?.setting_value
      ) || 0;

    const earningTransactions = earnings.map((e) => {
      const platformCommission =
        e.merchant_product_total * (commissionRate / 100);
      const netEarning = e.merchant_product_total - platformCommission; // Simple earning for now
      return {
        id: `e-${e.id}`,
        amount: netEarning.toFixed(2),
        type: "earning",
        status: "completed",
        description: `أرباح من الطلب #${e.id}`,
        created_at: e.created_at,
        reference_id: e.id,
      };
    });

    // 3. Combine and sort all transactions by date
    const allTransactions = [...payoutTransactions, ...earningTransactions];
    allTransactions.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    res.json(allTransactions);
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
    const [walletResult] = await connection.query(
      "SELECT balance FROM merchant_wallets WHERE merchant_id = ? FOR UPDATE",
      [merchantId]
    );
    const currentBalance =
      walletResult.length > 0 ? parseFloat(walletResult[0].balance) : 0;

    if (walletResult.length === 0 || currentBalance < numericAmount) {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "رصيدك غير كاف لإتمام عملية السحب." });
    }

    await connection.query(
      "UPDATE merchant_wallets SET balance = balance - ? WHERE merchant_id = ?",
      [numericAmount, merchantId]
    );
    await connection.query(
      "INSERT INTO payout_requests (merchant_id, amount) VALUES (?, ?)",
      [merchantId, numericAmount]
    );

    await connection.commit();
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
        (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE user_id = ? AND type = 'earning' AND status = 'cleared') as balance,
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
 * @desc    Get available payout methods for models
 * @route   GET /api/wallet/model/payout-methods
 * @access  Private (Model/Influencer)
 */
exports.getModelPayoutMethods = async (req, res) => {
  // في نظام حقيقي، هذه البيانات ستكون من قاعدة البيانات
  // الآن، سنقوم بإرجاع بيانات وهمية لتشغيل الواجهة الأمامية
  const methods = [
    {
      id: "bank-transfer-sa",
      type: "bank",
      name: "تحويل بنكي (السعودية)",
      details: "ينتهي بـ **** 1234",
      isDefault: true,
    },
    {
      id: "stc-pay",
      type: "wallet",
      name: "STC Pay",
      details: "055 **** 5678",
      isDefault: false,
    },
  ];
  res.status(200).json(methods);
};

/**
 * @desc    Create a new payout request for a model/influencer
 * @route   POST /api/wallet/model/request-payout
 * @access  Private (Model/Influencer)
 */
exports.requestModelPayout = async (req, res) => {
  const userId = req.user.id;
  // الواجهة الأمامية ترسل method_id، يجب استقباله
  const { amount, method_id } = req.body;
  const numericAmount = Number(amount);

  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ message: "الرجاء إدخال مبلغ صحيح." });
  }
  if (numericAmount < 50) {
    return res
      .status(400)
      .json({ message: "الحد الأدنى لطلب السحب هو 50 ريال." });
  }
  if (!method_id) {
    return res.status(400).json({ message: "الرجاء تحديد وسيلة الدفع." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // حساب الرصيد المتاح مباشرة من المعاملات المكتملة
    const [[wallet]] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as balance 
       FROM wallet_transactions 
       WHERE user_id = ? AND type = 'earning' AND status = 'cleared' FOR UPDATE`,
      [userId]
    );
    const availableBalance = parseFloat(wallet.balance);

    if (availableBalance < numericAmount) {
      await connection.rollback();
      return res
        .status(400)
        .json({ message: "رصيدك غير كافٍ لإتمام عملية السحب." });
    }

    // 1. إنشاء معاملة سحب جديدة في wallet_transactions بالسالب
    await connection.query(
      `INSERT INTO wallet_transactions (user_id, amount, type, status, description) 
       VALUES (?, ?, 'payout', 'cleared', ?)`,
      [userId, -numericAmount, `طلب سحب إلى ${method_id}`]
    );

    // 2. تسجيل طلب السحب للمراجعة الإدارية
    await connection.query(
      "INSERT INTO model_payout_requests (user_id, amount, payout_method_id) VALUES (?, ?, ?)",
      [userId, numericAmount, method_id]
    );

    await connection.commit();
    res.status(201).json({ message: "تم إرسال طلب السحب بنجاح." });
  } catch (error) {
    await connection.rollback();
    console.error("Error requesting model payout:", error);
    res.status(500).json({ message: "حدث خطأ أثناء معالجة طلبك." });
  } finally {
    connection.release();
  }
};
