// linora-platform/backend/controllers/contactController.js

const asyncHandler = require("express-async-handler");
const sendEmail = require("../utils/emailService"); //  استيراد خدمة البريد الإلكتروني

// @desc    Send contact form message
// @route   POST /api/contact
// @access  Public
const sendContactMessage = asyncHandler(async (req, res) => {
  const { name, email, phone, message } = req.body;

  if (!name || !email || !message) {
    res.status(400);
    throw new Error("الرجاء تعبئة جميع الحقول المطلوبة");
  }

  const contactSubject = `رسالة جديدة من ${name} عبر نموذج التواصل`;
  const contactHtml = `
  <div style="
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background-color: #f4f6f8;
    padding: 40px;
    color: #333;
  ">
    <div style="
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      overflow: hidden;
    ">
      <div style="background-color: #3b82f6; padding: 20px; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 22px;">📩 رسالة جديدة من <span style="color: #ffffff;">لينورا</span></h1>
      </div>
      
      <div style="padding: 25px;">
        <h2 style="font-size: 18px; color: #111;">تفاصيل المرسل:</h2>
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
          <tr>
            <td style="padding: 8px 0; font-weight: 600; width: 150px;">الاسم:</td>
            <td style="padding: 8px 0;">${name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">البريد الإلكتروني:</td>
            <td style="padding: 8px 0;">${email}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">رقم الهاتف:</td>
            <td style="padding: 8px 0;">${phone || "لم يتم إدخاله"}</td>
          </tr>
        </table>

        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

        <h2 style="font-size: 18px; color: #111;">نص الرسالة:</h2>
        <div style="
          background-color: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 15px;
          line-height: 1.7;
          white-space: pre-wrap;
        ">
          ${message}
        </div>
      </div>

      <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 13px; color: #555;">
        <p style="margin: 0;">تم إرسال هذه الرسالة عبر نموذج الاتصال في <strong>منصة لينورا</strong>.</p>
      </div>
    </div>
  </div>
`;

  try {
    await sendEmail({
      to: "mojagd112@gmail.com", // بريد المسؤول لاستقبال الرسائل
      subject: contactSubject,
      html: contactHtml,
    });

    res.status(200).json({ message: "تم إرسال الرسالة بنجاح" });
  } catch (error) {
    console.error(error);
    res.status(500);
    throw new Error("حدث خطأ أثناء إرسال البريد الإلكتروني");
  }
});

module.exports = {
  sendContactMessage,
};