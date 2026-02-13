// backend/jobs/clearPendingFunds.js
const cron = require("node-cron");
const pool = require("../config/db");

/**
 * وظيفة لتشغيل نظام تصفية الأرباح تلقائياً
 * تعمل كل يوم عند منتصف الليل
 */
const startClearanceJob = () => {
  // الجدولة: 0 0 * * * تعني كل يوم الساعة 00:00
  cron.schedule("0 0 * * *", async () => {
    console.log("⏳ [Cron Job] Starting daily fund clearance check...");

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 1. البحث عن المعاملات المستحقة للتحرير
      // الشروط: حالتها 'pending' + تاريخ الاستحقاق وصل أو فات + ليست عملية سحب (لأن السحب له دورة مختلفة)
      const [dueTransactions] = await connection.query(
        `SELECT id, wallet_id, amount, type 
         FROM wallet_transactions 
         WHERE status = 'pending' 
         AND available_at <= NOW() 
         AND type IN ('sale_earning', 'shipping_earning', 'agreement_income') 
         FOR UPDATE`,
      );

      if (dueTransactions.length === 0) {
        console.log("✅ [Cron Job] No pending funds to clear today.");
        await connection.rollback(); // لا داعي للإكمال
        return;
      }

      console.log(
        `💰 [Cron Job] Found ${dueTransactions.length} transactions to clear.`,
      );

      // 2. معالجة كل معاملة
      for (const trx of dueTransactions) {
        // أ) تحديث حالة المعاملة إلى 'cleared'
        await connection.query(
          "UPDATE wallet_transactions SET status = 'cleared' WHERE id = ?",
          [trx.id],
        );

        // ب) تحديث المحفظة:
        // - نقص الرصيد المعلق (pending_balance)
        // - زيادة الرصيد المتاح (balance)
        // - زيادة إجمالي الأرباح التاريخية (total_earnings)
        await connection.query(
          `UPDATE wallets 
           SET 
             pending_balance = pending_balance - ?,
             balance = balance + ?,
             total_earnings = total_earnings + ?
           WHERE id = ?`,
          [trx.amount, trx.amount, trx.amount, trx.wallet_id],
        );
      }

      await connection.commit();
      console.log("✅ [Cron Job] Funds cleared successfully.");
    } catch (error) {
      await connection.rollback();
      console.error("❌ [Cron Job] Error during fund clearance:", error);
    } finally {
      connection.release();
    }
  });
};

module.exports = startClearanceJob;
