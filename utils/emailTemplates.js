// backend/utils/emailTemplates.js

const baseStyle = `
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  max-width: 600px;
  margin: 0 auto;
  background-color: #ffffff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
`;

const headerStyle = `
  background: linear-gradient(90deg, #ec4899 0%, #8b5cf6 100%);
  padding: 20px;
  text-align: center;
  color: white;
`;

const contentStyle = `
  padding: 30px 20px;
  color: #333333;
  line-height: 1.6;
`;

const buttonStyle = `
  display: inline-block;
  background-color: #8b5cf6;
  color: white;
  padding: 12px 24px;
  text-decoration: none;
  border-radius: 5px;
  font-weight: bold;
  margin-top: 20px;
`;

const footerStyle = `
  background-color: #f9fafb;
  padding: 15px;
  text-align: center;
  font-size: 12px;
  color: #666666;
  border-top: 1px solid #e0e0e0;
`;

// دالة مساعدة لإنشاء الهيكل العام
const wrapTemplate = (title, body) => {
  return `
    <div style="${baseStyle}" dir="rtl">
      <div style="${headerStyle}">
        <h1 style="margin:0; font-size: 24px;">Linora | لينيورا</h1>
      </div>
      <div style="${contentStyle}">
        <h2 style="color: #8b5cf6; margin-top: 0;">${title}</h2>
        ${body}
      </div>
      <div style="${footerStyle}">
        <p>&copy; ${new Date().getFullYear()} منصة لينيورا. جميع الحقوق محفوظة.</p>
        <p>هذا بريد إلكتروني تلقائي، الرجاء عدم الرد عليه.</p>
      </div>
    </div>
  `;
};

module.exports = {
  // 1. ترحيب بالعميل الجديد
  welcomeEmail: (name) => {
    const body = `
      <p>مرحباً <strong>${name}</strong>،</p>
      <p>سعداء جداً بانضمامك إلى عائلة لينيورا! 🌟</p>
      <p>يمكنك الآن تصفح آلاف المنتجات والتواصل مع المودلز والمؤثرين.</p>
      <center><a href="${process.env.FRONTEND_URL}" style="${buttonStyle}">ابدأ التسوق الآن</a></center>
    `;
    return wrapTemplate('أهلاً بك في لينورا!', body);
  },

  // 2. فاتورة العميل (تأكيد الطلب)
  orderConfirmation: (name, orderId, totalAmount, items) => {
    const itemsList = items.map(item => 
      `<li style="margin-bottom: 5px;">${item.name} (x${item.quantity}) - ${item.price} ر.س</li>`
    ).join('');

    const body = `
      <p>مرحباً <strong>${name}</strong>،</p>
      <p>شكراً لثقتك بنا. تم استلام طلبك بنجاح وهو الآن قيد المعالجة.</p>
      
      <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 5px 0;"><strong>رقم الطلب:</strong> #${orderId}</p>
        <p style="margin: 5px 0;"><strong>الإجمالي:</strong> ${totalAmount} ر.س</p>
        <hr style="border: 0; border-top: 1px solid #d1d5db; margin: 10px 0;">
        <ul style="list-style-type: none; padding: 0; margin: 0;">
          ${itemsList}
        </ul>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/my-orders/${orderId}" style="${buttonStyle}">تتبع طلبك</a></center>
    `;
    return wrapTemplate('تم تأكيد طلبك ✅', body);
  },

  // 3. إشعار للتاجر بوجود طلب جديد
  newOrderForMerchant: (merchantName, orderId, items) => {
    const itemsList = items.map(item => `<li>${item}</li>`).join('');
    const body = `
      <p>مرحباً <strong>${merchantName}</strong>،</p>
      <p>تهانينا! لقد تلقيت طلباً جديداً. 🎉</p>
      
      <div style="background-color: #eff6ff; padding: 15px; border-radius: 8px; border: 1px solid #bfdbfe;">
        <p><strong>رقم الطلب:</strong> #${orderId}</p>
        <p><strong>المنتجات المطلوبة:</strong></p>
        <ul>${itemsList}</ul>
      </div>

      <p>يرجى تجهيز الطلب وشحنه في أقرب وقت لضمان رضا العميل.</p>
      <center><a href="${process.env.FRONTEND_URL}/dashboard/orders/${orderId}" style="${buttonStyle}">إدارة الطلب</a></center>
    `;
    return wrapTemplate('طلب جديد وارد 📦', body);
  },

  // 4. تحديث حالة الطلب
  orderStatusUpdate: (name, orderId, status) => {
    const statusMap = {
      'processing': 'قيد التجهيز ⚙️',
      'shipped': 'تم الشحن 🚚',
      'completed': 'مكتمل ✅',
      'cancelled': 'ملغي ❌'
    };
    const statusText = statusMap[status] || status;

    const body = `
      <p>مرحباً <strong>${name}</strong>،</p>
      <p>نود إعلامك بأنه تم تحديث حالة طلبك رقم <strong>#${orderId}</strong>.</p>
      
      <div style="text-align: center; margin: 20px 0;">
        <span style="font-size: 18px; font-weight: bold; background-color: #f3f4f6; padding: 10px 20px; border-radius: 20px;">
          الحالة الجديدة: ${statusText}
        </span>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/my-orders/${orderId}" style="${buttonStyle}">تفاصيل الطلب</a></center>
    `;
    return wrapTemplate('تحديث حالة الطلب', body);
  },

  payoutRequestAdmin: (userName, userType, amount, requestId) => {
    const body = `
      <p>مرحباً فريق الإدارة،</p>
      <p>تم استلام طلب سحب رصيد جديد.</p>
      
      <div style="background-color: #fff7ed; padding: 15px; border-radius: 8px; border: 1px solid #fed7aa; margin: 20px 0;">
        <p><strong>مقدم الطلب:</strong> ${userName} (${userType})</p>
        <p><strong>المبلغ:</strong> ${amount} ر.س</p>
        <p><strong>رقم الطلب:</strong> #${requestId}</p>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/admin/payouts" style="${buttonStyle}">مراجعة الطلب</a></center>
    `;
    return wrapTemplate('طلب سحب رصيد جديد 💰', body);
  },

  // 6. تحديث حالة طلب السحب (للمستخدم)
  payoutStatusUpdate: (name, amount, status, notes) => {
    const isApproved = status === 'approved';
    const statusText = isApproved ? 'تمت الموافقة ✅' : 'تم الرفض ❌';
    const color = isApproved ? '#ecfdf5' : '#fef2f2';
    const borderColor = isApproved ? '#6ee7b7' : '#fca5a5';

    let body = `
      <p>مرحباً <strong>${name}</strong>،</p>
      <p>تم تحديث حالة طلب سحب الرصيد الخاص بك بمبلغ <strong>${amount} ر.س</strong>.</p>
      
      <div style="background-color: ${color}; padding: 15px; border-radius: 8px; border: 1px solid ${borderColor}; margin: 20px 0; text-align: center;">
        <h3 style="margin: 0;">${statusText}</h3>
        ${notes ? `<p style="margin-top: 10px; font-size: 14px;">ملاحظات: ${notes}</p>` : ''}
      </div>
    `;

    if (isApproved) {
        body += `<p>سيتم إيداع المبلغ في حسابك البنكي خلال أيام العمل الرسمية.</p>`;
    } else {
        body += `<p>تم إعادة المبلغ إلى محفظتك في المنصة.</p>`;
    }

    return wrapTemplate('تحديث بخصوص طلب السحب', body);
  },

  // 7. إشعار للإدارة بطلب توثيق
  verificationRequestAdmin: (merchantName) => {
    const body = `
      <p>مرحباً فريق الإدارة،</p>
      <p>قام التاجر <strong>${merchantName}</strong> بإرسال مستندات التوثيق للمراجعة.</p>
      <center><a href="${process.env.FRONTEND_URL}/dashboard/admin/verifications" style="${buttonStyle}">مراجعة المستندات</a></center>
    `;
    return wrapTemplate('طلب توثيق جديد 🛡️', body);
  },

  // 8. نتيجة التوثيق (للتاجر)
  verificationResult: (name, status, reason) => {
    const isApproved = status === 'approved';
    const title = isApproved ? 'تم توثيق حسابك بنجاح! 🎉' : 'تحديث بخصوص طلب التوثيق';
    
    let body = `<p>مرحباً <strong>${name}</strong>،</p>`;
    
    if (isApproved) {
      body += `
        <p>يسعدنا إخبارك بأنه تمت مراجعة مستنداتك والموافقة عليها.</p>
        <p>حسابك الآن موثق بالكامل ويمكنك الاستفادة من كافة ميزات المنصة.</p>
        <center><a href="${process.env.FRONTEND_URL}/dashboard" style="${buttonStyle}">انتقل للوحة التحكم</a></center>
      `;
    } else {
      body += `
        <p>نأسف لإبلاغك بأنه لم يتم قبول طلب التوثيق للأسباب التالية:</p>
        <div style="background-color: #fef2f2; padding: 15px; border-radius: 8px; border: 1px solid #fca5a5; color: #b91c1c;">
          ${reason}
        </div>
        <p>يرجى تصحيح الملاحظات وإعادة إرسال الطلب.</p>
      `;
    }

    return wrapTemplate(title, body);
  },

  authVerificationCode: (code, type = 'تفعيل الحساب') => {
    const body = `
      <div style="text-align: center;">
        <p>مرحباً،</p>
        <p>لقد تلقينا طلباً لـ <strong>${type}</strong> في منصة لينيورا.</p>
        <p>استخدم الرمز التالي لإكمال العملية:</p>
        
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 10px; margin: 30px 0; display: inline-block;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1f2937;">${code}</span>
        </div>

        <p style="color: #6b7280; font-size: 14px;">هذا الرمز صالح لمدة 10 دقائق فقط.</p>
        <p style="color: #6b7280; font-size: 14px;">إذا لم تطلب هذا الرمز، يرجى تجاهل هذه الرسالة.</p>
      </div>
    `;
    return wrapTemplate('رمز التحقق الخاص بك 🔐', body);
  },

  // 10. رابط استعادة كلمة المرور
  passwordResetRequest: (resetUrl) => {
    const body = `
      <p>مرحباً،</p>
      <p>لقد تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك.</p>
      <p>اضغط على الزر أدناه لإنشاء كلمة مرور جديدة:</p>
      
      <center>
        <a href="${resetUrl}" style="${buttonStyle}">إعادة تعيين كلمة المرور</a>
      </center>

      <p style="margin-top: 30px; font-size: 12px; color: #666;">
        أو يمكنك نسخ الرابط التالي ولصقه في المتصفح:<br>
        <a href="${resetUrl}" style="color: #8b5cf6;">${resetUrl}</a>
      </p>
      
      <p style="color: #ef4444; font-size: 14px; margin-top: 20px;">هذا الرابط صالح لمدة 10 دقائق فقط.</p>
    `;
    return wrapTemplate('استعادة كلمة المرور 🔑', body);
  },

  newAgreementRequest: (modelName, merchantName, packageTitle) => {
    const body = `
      <p>مرحباً <strong>${modelName}</strong>،</p>
      <p>لديك عرض تعاون جديد من التاجر <strong>${merchantName}</strong>.</p>
      
      <div style="background-color: #f0f9ff; padding: 15px; border-radius: 8px; border: 1px solid #bae6fd; margin: 20px 0;">
        <p><strong>الباقة المطلوبة:</strong> ${packageTitle}</p>
        <p>يرجى مراجعة العرض وقبوله أو رفضه في أقرب وقت.</p>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/requests" style="${buttonStyle}">مراجعة العرض</a></center>
    `;
    return wrapTemplate('فرصة تعاون جديدة! 🌟', body);
  },

  // 12. تحديث حالة الاتفاق (للتاجر)
  agreementStatusUpdate: (merchantName, modelName, status, packageTitle) => {
    const isAccepted = status === 'accepted';
    const statusText = isAccepted ? 'تم القبول ✅' : 'تم الرفض ❌';
    const color = isAccepted ? '#ecfdf5' : '#fef2f2';
    
    const body = `
      <p>مرحباً <strong>${merchantName}</strong>،</p>
      <p>قام المودل <strong>${modelName}</strong> بالرد على طلب التعاون الخاص بك لباقة "<strong>${packageTitle}</strong>".</p>
      
      <div style="background-color: ${color}; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center;">
        <h3 style="margin: 0;">${statusText}</h3>
      </div>

      ${isAccepted ? '<p>سيبدأ العمل على الاتفاق قريباً. يمكنك التواصل مع المودل عبر الرسائل.</p>' : '<p>تم إلغاء حجز المبلغ وإعادته إلى حسابك.</p>'}
      
      <center><a href="${process.env.FRONTEND_URL}/dashboard/agreements" style="${buttonStyle}">تفاصيل الاتفاق</a></center>
    `;
    return wrapTemplate('تحديث بخصوص طلب التعاون', body);
  },

  // 13. اكتمال الاتفاق والأرباح (للمودل)
  agreementCompleted: (modelName, packageName, earnings) => {
    const body = `
      <p>مرحباً <strong>${modelName}</strong>،</p>
      <p>تهانينا! قام التاجر بتأكيد اكتمال العمل على باقة "<strong>${packageName}</strong>". 🎉</p>
      
      <div style="background-color: #fdf4ff; padding: 20px; border-radius: 8px; border: 1px solid #f0abfc; margin: 20px 0; text-align: center;">
        <p style="margin:0; font-size: 14px; color: #86198f;">تم إضافة الأرباح إلى رصيدك المعلق</p>
        <h2 style="margin: 10px 0; color: #a21caf;">+${earnings} ر.س</h2>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/wallet" style="${buttonStyle}">محفظتي</a></center>
    `;
    return wrapTemplate('دفعة جديدة! 💸', body);
  },

  // 14. رسالة جديدة (للمستخدم غير المتصل)
  newMessageNotification: (receiverName, senderName, messagePreview) => {
    const body = `
      <p>مرحباً <strong>${receiverName}</strong>،</p>
      <p>لديك رسالة جديدة غير مقروءة من <strong>${senderName}</strong>.</p>
      
      <div style="background-color: #f9fafb; padding: 15px; border-radius: 8px; border-left: 4px solid #8b5cf6; margin: 20px 0; font-style: italic;">
        "${messagePreview || 'مرفق صورة/فيديو'}"
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/messages" style="${buttonStyle}">الرد الآن</a></center>
    `;
    return wrapTemplate('رسالة جديدة 💬', body);
  },

  agreementStarted: (merchantName, modelName, packageTitle) => {
    const body = `
      <p>مرحباً <strong>${merchantName}</strong>،</p>
      <p>نود إعلامك بأن المودل <strong>${modelName}</strong> قد بدأ العمل فعلياً على اتفاق باقة "<strong>${packageTitle}</strong>".</p>
      
      <div style="background-color: #f0fdf4; padding: 15px; border-radius: 8px; border: 1px solid #bbf7d0; margin: 20px 0; text-align: center;">
        <p style="margin:0; font-size: 16px; color: #15803d;">الحالة: <strong>قيد التنفيذ ⏳</strong></p>
      </div>

      <p>سيتم إشعارك مجدداً عند تسليم العمل.</p>
      <center><a href="${process.env.FRONTEND_URL}/dashboard/agreements" style="${buttonStyle}">متابعة الاتفاق</a></center>
    `;
    return wrapTemplate('بدء العمل على الاتفاق 🚀', body);
  },

  // 16. إشعار تسليم العمل (للتاجر)
  agreementDelivered: (merchantName, modelName, packageTitle) => {
    const body = `
      <p>مرحباً <strong>${merchantName}</strong>،</p>
      <p>خبر رائع! قام المودل <strong>${modelName}</strong> بتسليم العمل المطلوب لباقة "<strong>${packageTitle}</strong>".</p>
      
      <div style="background-color: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fde68a; margin: 20px 0;">
        <p>يرجى مراجعة العمل المسلم وتأكيد الاستلام لإكمال الاتفاق وتحرير الأرباح للمودل.</p>
      </div>

      <center><a href="${process.env.FRONTEND_URL}/dashboard/agreements" style="${buttonStyle}">مراجعة واستلام العمل</a></center>
    `;
    return wrapTemplate('تم تسليم العمل! 📦', body);
  },

  newOrderForSupplier: (supplierName, orderId, items) => {
    const itemsList = items.map(item => `<li>${item}</li>`).join('');
    const body = `
      <p>مرحباً <strong>${supplierName}</strong>،</p>
      <p>لديك طلب توريد جديد (Dropshipping) برقم <strong>#${orderId}</strong>.</p>
      
      <div style="background-color: #fffbeb; padding: 15px; border-radius: 8px; border: 1px solid #fcd34d; margin: 20px 0;">
        <p><strong>المنتجات المطلوبة:</strong></p>
        <ul>${itemsList}</ul>
      </div>

      <p>يرجى تجهيز المنتجات وشحنها للعميل في أقرب وقت.</p>
      <center><a href="${process.env.FRONTEND_URL}/dashboard/supplier/orders" style="${buttonStyle}">إدارة الطلبات</a></center>
    `;
    return wrapTemplate('طلب توريد جديد 📦', body);
  },

  // 18. تنبيه انخفاض المخزون
  lowStockWarning: (name, productName, currentStock) => {
    const body = `
      <p>مرحباً <strong>${name}</strong>،</p>
      <p>نود تنبيهك بأن مخزون المنتج <strong>"${productName}"</strong> قد انخفض.</p>
      
      <div style="text-align: center; margin: 20px 0;">
        <span style="font-size: 24px; font-weight: bold; color: #ef4444;">المتبقي: ${currentStock} قطعة فقط</span>
      </div>

      <p>يرجى إعادة تعبئة المخزون لضمان استمرار المبيعات.</p>
      <center><a href="${process.env.FRONTEND_URL}/dashboard/products" style="${buttonStyle}">إدارة المخزون</a></center>
    `;
    return wrapTemplate('تنبيه: مخزون منخفض ⚠️', body);
  },

  // 19. إلغاء طلب (للمورد)
  orderCancelledSupplier: (supplierName, orderId) => {
    const body = `
      <p>مرحباً <strong>${supplierName}</strong>،</p>
      <p>يرجى العلم بأنه تم إلغاء الطلب رقم <strong>#${orderId}</strong>.</p>
      <div style="background-color: #fee2e2; padding: 15px; border-radius: 8px; border: 1px solid #fca5a5; color: #b91c1c;">
        <strong>تنبيه هام:</strong> إذا لم تقم بشحن الطلب بعد، يرجى عدم شحنه.
      </div>
    `;
    return wrapTemplate('إلغاء طلب ❌', body);
  },
};