const jwt = require("jsonwebtoken");
const db = require("./db");

const SECRET = process.env.JWT_SECRET;

/**
 * Rooms used:
 *   "drivers:online"  — every online driver's socket. New ride requests
 *                        are broadcast here (see routes/rides.js).
 *   "ride:<rideId>"   — the rider and the assigned driver for one ride.
 *                        Location ticks and status changes go here.
 *
 * Client contract (matches the Dispatch object in the frontend):
 *   connect with  io(url, { auth: { token } })
 *   emit "ride:subscribe"   { rideId }         after creating/accepting a ride
 *   emit "driver:online"    { online: bool }   when a driver flips the switch
 *   emit "driver:location"  { lat, lng, rideId? }  every few seconds while online
 *   listen "ride:new"            — new ride available (drivers)
 *   listen "ride:accepted"       — a driver took the ride (rider)
 *   listen "ride:updated"        — any status change (both)
 *   listen "ride:driverLocation" — live GPS tick (rider, while on a ride)
 */
function setupSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Missing auth token."));
      const payload = jwt.verify(token, SECRET);
      socket.user = { id: payload.sub, role: payload.role };
      next();
    } catch (e) {
      next(new Error("Invalid or expired token."));
    }
  });

  io.on("connection", (socket) => {
    socket.on("ride:subscribe", ({ rideId }) => {
      if (rideId) socket.join("ride:" + rideId);
    });

    socket.on("driver:online", ({ online }) => {
      if (socket.user.role !== "driver") return;
      if (online) socket.join("drivers:online");
      else socket.leave("drivers:online");
      db.prepare("UPDATE driver_profiles SET is_online=?, updated_at=datetime('now') WHERE user_id=?")
        .run(online ? 1 : 0, socket.user.id);
    });

    socket.on("driver:location", ({ lat, lng, rideId }) => {
      if (socket.user.role !== "driver" || typeof lat !== "number" || typeof lng !== "number") return;
      db.prepare("UPDATE driver_profiles SET last_lat=?, last_lng=? WHERE user_id=?")
        .run(lat, lng, socket.user.id);
      if (rideId) {
        io.to("ride:" + rideId).emit("ride:driverLocation", { lat, lng });
      }
    });

    socket.on("disconnect", () => {
      if (socket.user.role === "driver") {
        db.prepare("UPDATE driver_profiles SET is_online=0, updated_at=datetime('now') WHERE user_id=?")
          .run(socket.user.id);
      }
    });
  });
}

module.exports = setupSocket;
