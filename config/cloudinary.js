const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const pool = require('./db');

let isCloudinaryConfigured = false;

async function initializeCloudinary() {
    try {
        console.log('Attempting to initialize Cloudinary...');
        const [settings] = await pool.query(
            "SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN (?, ?, ?)",
            ['cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret']
        );
        
        const config = settings.reduce((acc, setting) => {
            acc[setting.setting_key] = setting.setting_value;
            return acc;
        }, {});

        if (config.cloudinary_cloud_name && config.cloudinary_api_key && config.cloudinary_api_secret) {
            cloudinary.config({
                cloud_name: config.cloudinary_cloud_name,
                api_key: config.cloudinary_api_key,
                api_secret: config.cloudinary_api_secret,
            });
            isCloudinaryConfigured = true;
            console.log('✅ Cloudinary initialized successfully.');
        } else {
            console.error('❌ FATAL: Cloudinary settings are incomplete in the database.');
        }

    } catch (error) {
        console.error('❌ Failed to initialize Cloudinary from database settings:', error);
    }
}

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'linora-products',
        allowed_formats: ['jpeg', 'png', 'jpg']
    }
});

// We export the configured cloudinary object directly
module.exports = { initializeCloudinary, cloudinary , storage};