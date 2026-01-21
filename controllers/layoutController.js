const pool = require('../config/db');

// جلب ترتيب الصفحة الرئيسية
exports.getHomeLayout = async (req, res) => {
  try {
    // في mysql2 نستخدم [rows] لفك الهيكلة لأن النتيجة تأتي كمصفوفة
    const [rows] = await pool.query(
      "SELECT config_value FROM app_configs WHERE config_key = ?",
      ['home_layout']
    );

    if (rows.length > 0) {
      // MySQL يقوم بإرجاع JSON ككائن جاهز في الغالب، لا نحتاج لـ parse يدوياً
      res.json(rows[0].config_value);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error("Error fetching layout:", err.message);
    res.status(500).send('Server Error');
  }
};

// حفظ ترتيب الصفحة الرئيسية (للأدمن فقط)
exports.updateHomeLayout = async (req, res) => {
  try {
    const layout = req.body; 

    // التأكد من تحويل البيانات لنص JSON قبل الحفظ (أحياناً يكون ضرورياً مع بعض إصدارات MySQL)
    const layoutJson = JSON.stringify(layout);

    // جملة الاستعلام المتوافقة مع MySQL (Upsert)
    const query = `
      INSERT INTO app_configs (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE 
        config_value = VALUES(config_value), 
        updated_at = CURRENT_TIMESTAMP
    `;

    await pool.query(query, ['home_layout', layoutJson]);

    // MySQL لا يدعم RETURNING * مثل Postgres، لذا نجلب البيانات المحدثة يدوياً
    const [rows] = await pool.query(
        "SELECT config_value FROM app_configs WHERE config_key = ?", 
        ['home_layout']
    );

    res.json({ 
        message: 'تم حفظ تخطيط الصفحة الرئيسية بنجاح', 
        layout: rows[0].config_value 
    });

  } catch (err) {
    console.error("Error updating layout:", err.message);
    res.status(500).send('Server Error');
  }
};
