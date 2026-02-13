const pool = require("../config/db");

// جلب ترتيب الصفحة الرئيسية
exports.getHomeLayout = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT config_value FROM app_configs WHERE config_key = ?",
      ["home_layout"],
    );

    if (rows.length > 0) {
      let layoutData = rows[0].config_value;

      // ✅ حماية إضافية: إذا عادت البيانات كنص، نقوم بتحويلها لـ JSON
      if (typeof layoutData === "string") {
        try {
          layoutData = JSON.parse(layoutData);
        } catch (e) {
          console.error("Failed to parse layout JSON:", e);
          layoutData = []; // العودة لمصفوفة فارغة في حال فساد البيانات
        }
      }

      res.json(layoutData);
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error("Error fetching layout:", err.message);
    res.status(500).send("Server Error");
  }
};

// حفظ ترتيب الصفحة الرئيسية (للأدمن فقط)
exports.updateHomeLayout = async (req, res) => {
  try {
    const layout = req.body;

    if (!layout || !Array.isArray(layout)) {
      return res.status(400).json({ message: "Invalid layout data format" });
    }

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

    await pool.query(query, ["home_layout", layoutJson]);

    // MySQL لا يدعم RETURNING * مثل Postgres، لذا نجلب البيانات المحدثة يدوياً
    const [rows] = await pool.query(
      "SELECT config_value FROM app_configs WHERE config_key = ?",
      ["home_layout"],
    );

    res.json({
      message: "تم حفظ تخطيط الصفحة الرئيسية بنجاح",
      layout: rows[0].config_value,
    });
  } catch (err) {
    console.error("Error updating layout:", err.message);
    res.status(500).send("Server Error");
  }
};
