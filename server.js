require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const driverRoutes = require("./routes/drivers");
const rideRoutes = require("./routes/rides");
const adminRoutes = require("./routes/admin");
const { router: paymentsRoutes } = require("./routes/payments");
const pushRoutes = require("./routes/push");
const connectRoutes = require("./routes/connect");
const { router: promoRoutes } = require("./routes/promo");
const setupSocket = require("./socket");

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: "6mb" })); // 6mb: onboarding photo is a base64 data URL

app.get("/health", (req, res) => res.json({ ok: true, service: "pullup-backend" }));

app.use("/api/auth", authRoutes);
app.use("/api/drivers/connect", connectRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/rides", rideRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/promo", promoRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

const io = new Server(server, { cors: { origin: allowedOrigins.length ? allowedOrigins : true } });
app.set("io", io);
setupSocket(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Pull Up backend listening on :${PORT}`));
