// backend/jobs/clearPendingFunds.js
const pool = require('../config/db');

const clearPendingFunds = async () => {
    console.log('Running scheduled job: Clearing pending funds...');
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get the clearing period from admin settings
        const [[setting]] = await connection.query(
            "SELECT setting_value FROM platform_settings WHERE setting_key = 'payout_clearing_days'"
        );
        const clearingDays = parseInt(setting?.setting_value || '14', 10);

        // 2. Find all transactions that are past their clearing date and still pending
        const [transactionsToClear] = await connection.query(
            `SELECT id FROM wallet_transactions 
             WHERE status = 'pending_clearance' 
             AND created_at <= NOW() - INTERVAL ? DAY`,
            [clearingDays]
        );

        if (transactionsToClear.length === 0) {
            console.log('No funds to clear.');
            await connection.commit();
            return;
        }

        const transactionIds = transactionsToClear.map(t => t.id);

        // 3. Update their status to 'cleared'
        const [updateResult] = await connection.query(
            `UPDATE wallet_transactions 
             SET status = 'cleared', cleared_at = NOW() 
             WHERE id IN (?)`,
            [transactionIds]
        );

        await connection.commit();
        console.log(`Successfully cleared ${updateResult.affectedRows} transaction(s).`);

    } catch (error) {
        await connection.rollback();
        console.error('Error during clear pending funds job:', error);
    } finally {
        connection.release();
    }
};

module.exports = clearPendingFunds;