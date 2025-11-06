// backend/utils/emailService.js
// const { Resend } = require('resend');
const { getResend } = require('../config/resend');
// تحقق من وجود مفتاح API
// if (!process.env.RESEND_API_KEY) {
//   throw new Error('RESEND_API_KEY is not defined in your .env file');
// }



/**
 * دالة موحدة لإرسال البريد الإلكتروني باستخدام Resend
 * @param {object} options - خيارات البريد
 * @param {string} options.to - البريد الإلكتروني للمستلم
 * @param {string} options.subject - عنوان البريد الإلكتروني
 * @param {string} options.html - محتوى البريد بصيغة HTML
 */
const sendEmail = async ({ to, subject, html }) => {
  const resend = getResend();
  try {
    const { data, error } = await resend.emails.send({
      from: 'Linora <linyora@linyora.com>', // يجب أن يكون هذا النطاق معتمدًا في حسابك بـ Resend
      to: to, // Resend يتوقع مصفوفة من الإيميلات
      subject,
      html,
    });

    if (error) {
      console.error(`Error sending email via Resend:`, error);
      return; // لا توقف التنفيذ، فقط سجل الخطأ
    }

    console.log(`Email sent successfully to ${to} with ID: ${data.id}`);
  } catch (error) {
    console.error('An unexpected error occurred while sending email:', error);
  }
};

module.exports = sendEmail;