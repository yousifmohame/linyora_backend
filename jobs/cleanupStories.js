// backend/jobs/cleanupStories.js
const pool = require('../config/db');

const cleanupStories = async () => {
  try {
    console.log('⏳ Running cleanupStories job...');
    
    // حذف القصص التي انتهى وقت صلاحيتها
    // يمكنك أيضاً نقلها لجدول أرشيف (stories_archive) بدلاً من الحذف إذا أردت الاحتفاظ بالسجلات
    const [result] = await pool.query(`
      DELETE FROM stories 
      WHERE expires_at <= NOW()
    `);

    if (result.affectedRows > 0) {
        console.log(`✅ Cleanup complete. Deleted ${result.affectedRows} expired stories.`);
        
        // (اختياري) تنظيف الأقسام الفارغة التي لا تحتوي على قصص نشطة
        // await pool.query(`
        //    DELETE FROM story_sections 
        //    WHERE id NOT IN (SELECT DISTINCT section_id FROM stories WHERE section_id IS NOT NULL)
        // `);
    } else {
        console.log('👌 No expired stories found.');
    }
    
  } catch (error) {
    console.error('❌ Error cleaning up stories:', error);
  }
};

module.exports = cleanupStories;