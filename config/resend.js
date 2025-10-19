const { Resend } = require('resend');
const pool = require('./db');

let resendInstance = null;

async function initializeResend() {
    try {
        console.log('Attempting to initialize Resend...');
        const [settings] = await pool.query("SELECT setting_key, setting_value FROM platform_settings WHERE setting_key = 'resend_api_key'");
        
        const resendApiKeySetting = settings[0];
        
        if (!resendApiKeySetting || !resendApiKeySetting.setting_value) {
            console.error('❌ FATAL: Resend API key is not set in the database.');
            // Initialize with a dummy key to prevent a crash, though it will not send emails.
            resendInstance = new Resend('re_dummy_key_for_init');
            return;
        }

        const resendApiKey = resendApiKeySetting.setting_value;
        resendInstance = new Resend(resendApiKey);
        console.log('✅ Resend initialized successfully.');

    } catch (error) {
        console.error('❌ Failed to initialize Resend from database settings:', error);
        resendInstance = new Resend('re_dummy_key_for_init');
    }
}

const getResend = () => {
    if (!resendInstance) {
        console.warn('Resend has not been initialized. Make sure initializeResend() is called on server start.');
    }
    return resendInstance;
};

module.exports = { initializeResend, getResend };