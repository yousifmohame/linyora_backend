// backend/controllers/modelController.js
const pool = require("../config/db");

// [GET] جلب بيانات الملف الشخصي للمودل الحالية
exports.getMyProfile = async (req, res) => {
  try {
    const [profile] = await pool.query(
      "SELECT name, email, profile_picture_url, bio, portfolio, social_links, stats FROM users WHERE id = ?",
      [req.user.id]
    );

    if (profile.length === 0) {
      return res
        .status(404)
        .json({ message: "لم يتم العثور على الملف الشخصي." });
    }

    const userProfile = profile[0];
    userProfile.portfolio = userProfile.portfolio
      ? JSON.parse(userProfile.portfolio)
      : [];
    userProfile.social_links = userProfile.social_links
      ? JSON.parse(userProfile.social_links)
      : {};
    userProfile.stats = userProfile.stats ? JSON.parse(userProfile.stats) : {};

    res.status(200).json(userProfile);
  } catch (error) {
    res.status(500).json({ message: "خطأ في جلب الملف الشخصي." });
  }
};

// [PUT] تحديث الملف الشخصي للمودل الحالية
exports.updateMyProfile = async (req, res) => {
  const { name, bio, portfolio, social_links, stats, profile_picture_url } =
    req.body;
  try {
    await pool.query(
      `UPDATE users SET 
                name = ?, bio = ?, portfolio = ?, social_links = ?, stats = ?, profile_picture_url = ?
             WHERE id = ?`,
      [
        name,
        bio,
        JSON.stringify(portfolio || []),
        JSON.stringify(social_links || {}),
        JSON.stringify(stats || {}),
        profile_picture_url,
        req.user.id,
      ]
    );
    res.status(200).json({ message: "تم تحديث ملفك الشخصي بنجاح!" });
  } catch (error) {
    console.error("Error updating model profile:", error);
    res.status(500).json({ message: "فشل تحديث الملف الشخصي." });
  }
};

// --- ✨ [GET] دالة جلب إحصائيات لوحة التحكم (النسخة الكاملة والمصححة) ✨ ---
exports.getDashboardStats = async (req, res) => {
    const userId = req.user.id;
    try {
        const query = `
            SELECT
                -- 1. إجمالي الطلبات
                COUNT(a.id) as totalRequests,
                -- 2. الطلبات قيد الانتظار
                SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) as pendingRequests,
                -- 3. الاتفاقات المكتملة
                SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completedAgreements,
                -- 4. التعاونات القادمة (المقبولة ولم تكتمل بعد)
                SUM(CASE WHEN a.status = 'accepted' THEN 1 ELSE 0 END) as upcomingCollaborations,
                -- 5. إجمالي الأرباح
                COALESCE(SUM(CASE WHEN a.status = 'completed' THEN pt.price ELSE 0 END), 0) as totalEarnings,
                -- 6. أرباح الشهر الحالي (تم التصحيح هنا)
                COALESCE(SUM(CASE WHEN a.status = 'completed' AND MONTH(a.created_at) = MONTH(CURRENT_DATE()) AND YEAR(a.created_at) = YEAR(CURRENT_DATE()) THEN pt.price ELSE 0 END), 0) as monthlyEarnings
            FROM agreements a
            LEFT JOIN package_tiers pt ON a.package_tier_id = pt.id
            WHERE a.model_id = ?`;
            
        const [[stats]] = await pool.query(query, [userId]);

        // ملاحظة: مشاهدات الملف الشخصي ومعدل الرد يتطلبان منطق تتبع خاص
        // سنضع قيمًا ثابتة مؤقتًا كما هو متوقع في الواجهة الأمامية
        const profileViews = 1247; // قيمة ثابتة مؤقتة
        const responseRate = 95;   // قيمة ثابتة مؤقتة

        res.status(200).json({
            totalRequests: Number(stats.totalRequests) || 0,
            pendingRequests: Number(stats.pendingRequests) || 0,
            completedAgreements: Number(stats.completedAgreements) || 0,
            upcomingCollaborations: Number(stats.upcomingCollaborations) || 0,
            totalEarnings: parseFloat(stats.totalEarnings) || 0,
            monthlyEarnings: parseFloat(stats.monthlyEarnings) || 0,
            profileViews: profileViews,
            responseRate: responseRate,
        });
    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ message: 'خطأ في جلب الإحصائيات.' });
    }
};

// --- ✨ [GET] دالة جديدة لجلب النشاط الحديث ✨ ---
exports.getRecentActivity = async (req, res) => {
  const userId = req.user.id;
  try {
    // هذه الدالة ستجلب الإشعارات كـ "نشاط حديث"
    const [activities] = await pool.query(
      "SELECT id, type, message as title, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') as time, is_read FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
      [userId]
    );

    // تحويل البيانات لتناسب شكل RecentActivity في الواجهة الأمامية
    const formattedActivities = activities.map((act) => ({
      id: act.id,
      type: act.type.startsWith("AGREEMENT") ? "request" : "message", // تبسيط الأنواع
      title: act.title,
      description: `تم استلام إشعار جديد بخصوص ${act.title}`, // إضافة وصف بسيط
      time: act.time,
      isNew: !act.is_read,
    }));

    res.status(200).json(formattedActivities);
  } catch (error) {
    console.error("Error fetching recent activity:", error);
    res.status(500).json({ message: "فشل في جلب النشاط الحديث." });
  }
};

// --- ✨ دالة جلب بيانات التحليلات (النسخة المصححة والمحدثة لنظام الباقات) ✨ ---
exports.getAnalytics = async (req, res) => {
  const userId = req.user.id;
  try {
    const [
      earningsData,
      topPackages, // تم التغيير من topOffers
      requestsOverTime,
      performanceMetrics,
    ] = await Promise.all([
      // 1. إحصائيات الأرباح والاتفاقات (محدث)
      pool.query(
        `SELECT 
                    COALESCE(SUM(CASE WHEN a.status = 'completed' THEN pt.price ELSE 0 END), 0) as totalEarnings,
                    COUNT(CASE WHEN a.status = 'completed' THEN 1 END) as completedAgreements,
                    COALESCE(AVG(CASE WHEN a.status = 'completed' THEN pt.price END), 0) as averageDealPrice,
                    COUNT(a.id) as totalRequests
                 FROM agreements a
                 LEFT JOIN package_tiers pt ON a.package_tier_id = pt.id
                 WHERE a.model_id = ?`,
        [userId]
      ),
      // 2. أفضل الباقات أداءً (محدث)
      pool.query(
        `SELECT sp.title, pt.price, COUNT(a.id) as requestCount
                 FROM service_packages sp
                 JOIN package_tiers pt ON sp.id = pt.package_id
                 JOIN agreements a ON pt.id = a.package_tier_id
                 WHERE a.model_id = ? AND a.status = 'completed'
                 GROUP BY sp.id, pt.id
                 ORDER BY requestCount DESC, pt.price DESC
                 LIMIT 5`,
        [userId]
      ),
      // 3. عدد الطلبات شهريًا (بدون تغيير)
      pool.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(id) as count
                 FROM agreements
                 WHERE model_id = ? AND created_at >= NOW() - INTERVAL 6 MONTH
                 GROUP BY month
                 ORDER BY month ASC`,
        [userId]
      ),
      // 4. مقاييس الأداء المتقدمة (بدون تغيير)
      pool.query(
        `SELECT
                    (SELECT JSON_UNQUOTE(JSON_EXTRACT(stats, '$.engagement')) FROM users WHERE id = ?) as engagementRate,
                    (SELECT COALESCE(AVG(rating), 0) FROM agreement_reviews WHERE reviewee_id = ?) as satisfactionScore
                `,
        [userId, userId]
      ),
    ]);

    // حساب معدل الإكمال
    const totalRequests = earningsData[0][0].totalRequests || 0;
    const completedAgreements = earningsData[0][0].completedAgreements || 0;
    const completionRate =
      totalRequests > 0 ? (completedAgreements / totalRequests) * 100 : 0;

    const analytics = {
      totalEarnings: parseFloat(earningsData[0][0].totalEarnings),
      completedAgreements: parseInt(completedAgreements),
      averageDealPrice: parseFloat(earningsData[0][0].averageDealPrice),
      topOffers: topPackages[0], // اسم المتغير topOffers لتوافق الواجهة الأمامية
      requestsOverTime: requestsOverTime[0],
      performanceMetrics: {
        engagementRate:
          parseFloat(performanceMetrics[0][0].engagementRate) || 0,
        satisfactionScore:
          parseFloat(performanceMetrics[0][0].satisfactionScore) * 20,
        completionRate: parseFloat(completionRate.toFixed(1)),
        profileViews: 1247,
      },
    };

    res.status(200).json(analytics);
  } catch (error) {
    console.error("Error fetching model analytics:", error);
    res.status(500).json({ message: "Server error." });
  }
};
