// server.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { initializeStripe } = require("./config/stripe");
const { initializeResend } = require("./config/resend");
const { initializeCloudinary } = require("./config/cloudinary");
require("dotenv").config();

initializeStripe();
initializeResend();
initializeCloudinary();

const jwt = require("jsonwebtoken");
const pool = require("./config/db");
const cron = require("node-cron");
const clearPendingFunds = require("./jobs/clearPendingFunds");
const cleanupStories = require("./jobs/cleanupStories");

const paymentController = require("./controllers/paymentController");
const app = express();

// --- Cron Jobs ---
// Schedule to run once every day at 1:05 AM
cron.schedule(
  "5 1 * * *",
  () => {
    console.log("-------------------------------------");
    clearPendingFunds();
    console.log("-------------------------------------");
  },
  {
    scheduled: true,
    timezone: "Africa/Cairo", // Set to your server's timezone
  },
);

// 2. 👇 الوظيفة الجديدة (تنظيف القصص) - تعمل كل ساعة (في الدقيقة 0)

// cron.schedule('0 * * * *', () => {
//     console.log('--- 🧹 Starting Hourly Cleanup ---');
//     cleanupStories();
// }, {
//     scheduled: true,
//     timezone: "Africa/Cairo"
// });

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"],
  },
});

const port = process.env.PORT || 5000;

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paymentController.handlePaymentWebhook,
);

// Middlewares
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://linyora.com",
    "https://www.linyora.com",
  ], // حدد هنا نطاق الواجهة الأمامية الخاص بك
  optionsSuccessStatus: 200, // لبعض المتصفحات القديمة
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "1000mb" }));
app.use(express.urlencoded({ extended: true, limit: "1000mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 20, // الحد الأقصى للطلبات من نفس الـ IP
  message: {
    message:
      "تم تجاوز الحد المسموح لمحاولات الدخول. الرجاء المحاولة مرة أخرى بعد 15 دقيقة.",
  },
  standardHeaders: true, // يرسل معلومات الحد في الـ Headers
  legacyHeaders: false,
});

// رسالة اختبارية
app.get("/", (req, res) => {
  res.send("Linora Platform API is running... ✨");
});

// --- All API Routes ---
const authRoutes = require("./routes/auth");
app.use("/api/auth", authLimiter, authRoutes);
const userRoutes = require("./routes/userRoutes");
app.use("/api/users", userRoutes);
const merchantRoutes = require("./routes/merchantRoutes");
app.use("/api/merchants", merchantRoutes);
const productRoutes = require("./routes/productRoutes");
app.use("/api/products", productRoutes);
const orderRoutes = require("./routes/orderRoutes");
app.use("/api/orders", orderRoutes);
const offerRoutes = require("./routes/offerRoutes");
app.use("/api/offers", offerRoutes);
const browseRoutes = require("./routes/browseRoutes");
app.use("/api/browse", browseRoutes);
const agreementRoutes = require("./routes/agreementRoutes");
app.use("/api/agreements", agreementRoutes);
const adminRoutes = require("./routes/adminRoutes");
app.use("/api/admin", adminRoutes);
const notificationRoutes = require("./routes/notificationRoutes");
app.use("/api/notifications", notificationRoutes);
const customerRoutes = require("./routes/customerRoutes");
app.use("/api/customer", customerRoutes);
const uploadRoutes = require("./routes/uploadRoutes");
app.use("/api/upload", uploadRoutes);
const modelRoutes = require("./routes/modelRoutes");
app.use("/api/model", modelRoutes);
const dropshippingRoutes = require("./routes/dropshippingRoutes");
app.use("/api/dropshipping", dropshippingRoutes);
const paymentRoutes = require("./routes/paymentRoutes");
app.use("/api/payments", paymentRoutes);
const messageRoutes = require("./routes/messageRoutes");
app.use("/api/messages", messageRoutes);
const walletRoutes = require("./routes/walletRoutes");
app.use("/api/wallet", walletRoutes);
const supplierRoutes = require("./routes/supplierRoutes");
app.use("/api/supplier", supplierRoutes);
const contentRoutes = require("./routes/contentRoutes");
app.use("/api/content", contentRoutes);
const contactRoutes = require("./routes/contactRoutes");
app.use("/api/contact", contactRoutes);
const subscriptionRoutes = require("./routes/subscriptionRoutes");
app.use("/api/subscriptions", subscriptionRoutes);
const categoryRoutes = require("./routes/categoryRoutes");
app.use("/api/categories", categoryRoutes);
const mainBannerRoutes = require("./routes/mainBannerRoutes");
app.use("/api/main-banners", mainBannerRoutes);
const reelsRoutes = require("./routes/reelsRoutes");
app.use("/api/reels", reelsRoutes);
const marqueeRoutes = require("./routes/marqueeRoutes");
app.use("/api/marquee", marqueeRoutes);
const settingsRoutes = require("./routes/settingsRoutes");
app.use("/api/settings", settingsRoutes);
const sectionRoutes = require("./routes/sectionRoutes");
app.use("/api/sections", sectionRoutes);
const storyRoutes = require("./routes/storyRoutes");
app.use("/api/stories", storyRoutes);
const flashSaleRoutes = require("./routes/flashSaleRoutes");
app.use("/api/flash-sale", flashSaleRoutes);
const bankRoutes = require("./routes/bankRoutes");
app.use("/api/bank", bankRoutes);
const layoutRoutes = require("./routes/layoutRoutes"); // <--- أضف هذا
app.use("/api/layout", layoutRoutes); // <--- أضف هذا

// --- Socket.IO Connection Management ---
const userSocketMap = {};

io.on("connection", (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);
  let connectedUserId = null;

  socket.on("authenticate", async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      connectedUserId = decoded.id;
      userSocketMap[connectedUserId] = socket.id;

      await pool.query("UPDATE users SET is_online = TRUE WHERE id = ?", [
        connectedUserId,
      ]);

      console.log(`✅ User ${connectedUserId} authenticated and online.`);
      socket.broadcast.emit("userOnline", { userId: connectedUserId });
    } catch (error) {
      console.log(
        `❌ Socket authentication failed for ${socket.id}: ${error.message}`,
      );
    }
  });

  socket.on("markAsRead", async ({ conversationId }) => {
    if (!connectedUserId) return;

    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE conversation_id = ? AND receiver_id = ? AND is_read = FALSE",
      [conversationId, connectedUserId],
    );

    const [convo] = await pool.query(
      "SELECT merchant_id, model_id FROM conversations WHERE id = ?",
      [conversationId],
    );
    if (convo.length > 0) {
      const otherUserId =
        convo[0].merchant_id === connectedUserId
          ? convo[0].model_id
          : convo[0].merchant_id;
      const otherUserSocketId = userSocketMap[otherUserId];
      if (otherUserSocketId) {
        io.to(otherUserSocketId).emit("messagesRead", { conversationId });
      }
    }
  });

  socket.on("disconnect", async () => {
    if (connectedUserId) {
      await pool.query(
        "UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = ?",
        [connectedUserId],
      );

      delete userSocketMap[connectedUserId];
      console.log(`🔌 User ${connectedUserId} disconnected and offline.`);
      socket.broadcast.emit("userOffline", {
        userId: connectedUserId,
        last_seen: new Date(),
      });
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

app.set("io", io);
app.set("userSocketMap", userSocketMap);

httpServer.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
