const Stripe = require('stripe');
const pool = require('./db');

let stripeInstance = null;

async function initializeStripe() {
    try {
        console.log('Attempting to initialize Stripe...');
        const [settings] = await pool.query("SELECT setting_key, setting_value FROM platform_settings WHERE setting_key = 'stripe_secret_key'");
        
        const stripeSecretKeySetting = settings[0];
        
        if (!stripeSecretKeySetting || !stripeSecretKeySetting.setting_value) {
            console.error('❌ FATAL: Stripe secret key is not set in the database.');
            // In a real production app, you might want to prevent the server from starting.
            // For now, we'll initialize with a null key which will cause errors if used.
            stripeInstance = new Stripe('', { apiVersion: '2024-04-10' });
            return;
        }

        const stripeSecretKey = stripeSecretKeySetting.setting_value;
        stripeInstance = new Stripe(stripeSecretKey, {
            apiVersion: '2024-04-10',
        });
        console.log('✅ Stripe initialized successfully.');

    } catch (error) {
        console.error('❌ Failed to initialize Stripe from database settings:', error);
        // Fallback to a dummy instance to prevent crashing, but it won't work.
        stripeInstance = new Stripe('', { apiVersion: '2024-04-10' });
    }
}

// This function allows us to get the initialized instance
const getStripe = () => {
    if (!stripeInstance) {
        console.warn('Stripe has not been initialized. Make sure initializeStripe() is called on server start.');
    }
    return stripeInstance;
};

module.exports = { initializeStripe, getStripe };