const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { stripe } = require("./payments");

const router = express.Router();

const [AREA_S, AREA_W, AREA_N, AREA_E] = (process.env.AREA_BOUNDS || "37.46,-84.50,37.86,-83.80")
  .split(",")
  .map(Number);

function inArea(lat, lng) {
  return lat >= AREA_S && lat <= AREA_N && lng >= AREA_W && lng <= AREA_E;
}

function logEvent(rideId, type, payload) {
  db.prepare("INSERT INTO ride_events (ride_id, type, payload) VALUES (?, ?, ?)").run(
    rideId, type, payload ? JSON.stringify(payload) : null
  );
}

function shapeRide(row) {
  if (!row) return null;
  return {
    id: row.id,
    riderId: row.rider_id,
    driverId: row.driver_id,
    tier: row.tier,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng, label: row.pickup_label },
    dest: { lat: row.dest_lat, lng: row.dest_lng, label: row.dest_label },
    distanceMiles: row.distance_miles,
    durationMin: row.duration_min,
    fareCents: row.fare_cents,
    driverTakeCents: row.driver_take_cents,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    pin: row.pin, // only strip this before sending to the driver — see note below
    status: row.status,
    scheduledFor: row.scheduled_for,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// Riders get the PIN so they can read it to the driver. Drivers never
// see it in the payload — they collect it verbally and POST it back.
function shapeForRole(row, role, selfId) {
  const shaped = shapeRide(row);
  if (role === "driver" && row.driver_id === selfId) delete shaped.pin;
  return shaped;
}

router.post("/", requireAuth, requireRole("rider"), (req, res) => {
  const b = req.body || {};
  const { pickup, dest, tier, distanceMiles, durationMin, fareCents, paymentMethod, scheduledFor } = b;

  if (!pickup || !dest || !["std", "xl", "now"].includes(tier) || !fareCents) {
    return res.status(400).json({ error: "pickup, dest, tier, and fareCents are required." });
  }
  if (!inArea(pickup.lat, pickup.lng)) {
    return res.status(400).json({ error: "Pickup is outside the service area." });
  }

  const ride = {
    id: uuid(),
    rider_id: req.user.id,
    tier,
    pickup_lat: pickup.lat, pickup_lng: pickup.lng, pickup_label: pickup.label || "Pickup",
    dest_lat: dest.lat, dest_lng: dest.lng, dest_label: dest.label || "Destination",
    distance_miles: distanceMiles || 0,
    duration_min: durationMin || 0,
    fare_cents: Math.round(fareCents),
    payment_method: paymentMethod === "cash" ? "cash" : "card",
    pin: String(Math.floor(1000 + Math.random() * 9000)),
    scheduled_for: scheduledFor || null,
  };
  db.prepare(
    `INSERT INTO rides (id, rider_id, tier, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                         distance_miles, duration_min, fare_cents, payment_method, pin, scheduled_for)
     VALUES (@id, @rider_id, @tier, @pickup_lat, @pickup_lng, @pickup_label, @dest_lat, @dest_lng, @dest_label,
             @distance_miles, @duration_min, @fare_cents, @payment_method, @pin, @scheduled_for)`
  ).run(ride);
  logEvent(ride.id, "requested", { tier, fareCents: ride.fare_cents });

  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);

  // Tell every online driver in the service area a ride is up for grabs.
  // A real dispatch would rank by distance/ETA instead of broadcasting
  // to everyone; fine for a four-town launch, worth revisiting once
  // you have more than a handful of drivers online at once.
  req.app.get("io").to("drivers:online").emit("ride:new", shapeRide(row));

  res.status(201).json({ ride: shapeForRole(row, "rider", req.user.id) });
});

router.get("/mine", requireAuth, (req, res) => {
  const col = req.user.role === "driver" ? "driver_id" : "rider_id";
  const rows = db.prepare(`SELECT * FROM rides WHERE ${col} = ? ORDER BY requested_at DESC LIMIT 50`).all(req.user.id);
  res.json({ rides: rows.map(r => shapeForRole(r, req.user.role, req.user.id)) });
});

router.get("/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  const allowed = req.user.role === "admin" || row.rider_id === req.user.id || row.driver_id === req.user.id;
  if (!allowed) return res.status(403).json({ error: "Not your ride." });
  res.json({ ride: shapeForRole(row, req.user.role, req.user.id) });
});

router.post("/:id/accept", requireAuth, requireRole("driver"), (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  if (row.status !== "requested") return res.status(409).json({ error: "This ride is no longer available." });

  db.prepare("UPDATE rides SET driver_id=?, status='accepted', accepted_at=datetime('now') WHERE id=?")
    .run(req.user.id, row.id);
  logEvent(row.id, "accepted", { driverId: req.user.id });

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(row.id);
  const driver = db.prepare(
    `SELECT u.name, d.vehicle_year, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.vehicle_plate, d.rating, d.photo_url
     FROM users u JOIN driver_profiles d ON d.user_id = u.id WHERE u.id = ?`
  ).get(req.user.id);

  req.app.get("io").to("ride:" + row.id).emit("ride:accepted", { ride: shapeRide(updated), driver });
  res.json({ ride: shapeForRole(updated, "driver", req.user.id), driver });
});

const NEXT_STATUS = {
  accepted: ["arriving", "cancelled"],
  arriving: ["arrived", "cancelled"],
  arrived: ["onTrip", "cancelled"],
  onTrip: ["complete"],
};

router.patch("/:id/status", requireAuth, async (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });

  const isParticipant = row.rider_id === req.user.id || row.driver_id === req.user.id;
  if (!isParticipant) return res.status(403).json({ error: "Not your ride." });

  const { status, pin, reason } = req.body || {};
  const allowedNext = NEXT_STATUS[row.status] || [];
  if (status === "cancelled") {
    if (!["requested", "accepted", "arriving", "arrived"].includes(row.status)) {
      return res.status(409).json({ error: "This ride can no longer be cancelled." });
    }
  } else if (!allowedNext.includes(status)) {
    return res.status(409).json({ error: `Can't move from ${row.status} to ${status}.` });
  }

  if (status === "onTrip" && pin !== row.pin) {
    return res.status(400).json({ error: "That PIN doesn't match the rider's." });
  }

  if (status === "onTrip") {
    db.prepare("UPDATE rides SET status=?, started_at=datetime('now') WHERE id=?").run(status, row.id);
  } else if (status === "complete") {
    const driverTake = Math.round(row.fare_cents * 0.78);
    db.prepare("UPDATE rides SET status=?, completed_at=datetime('now'), driver_take_cents=? WHERE id=?")
      .run(status, driverTake, row.id);

    // Charge the rider now that the trip is actually done. This never
    // blocks the ride from completing — a driver shouldn't get stuck
    // because of a declined card. A failed charge is recorded on the
    // ride for the admin dashboard to chase down, not silently lost.
    if (row.payment_method === "card") {
      const rider = db.prepare("SELECT * FROM users WHERE id = ?").get(row.rider_id);
      if (!stripe) {
        db.prepare("UPDATE rides SET payment_status='failed' WHERE id=?").run(row.id);
        logEvent(row.id, "payment:failed", { reason: "Stripe not configured on server" });
      } else if (!rider.stripe_customer_id || !rider.stripe_payment_method_id) {
        db.prepare("UPDATE rides SET payment_status='failed' WHERE id=?").run(row.id);
        logEvent(row.id, "payment:failed", { reason: "Rider has no saved card" });
      } else {
        try {
          const intent = await stripe.paymentIntents.create({
            amount: row.fare_cents,
            currency: "usd",
            customer: rider.stripe_customer_id,
            payment_method: rider.stripe_payment_method_id,
            off_session: true,
            confirm: true,
            metadata: { ride_id: row.id },
          });
          db.prepare("UPDATE rides SET payment_status='paid', stripe_payment_intent_id=? WHERE id=?")
            .run(intent.id, row.id);
          logEvent(row.id, "payment:paid", { stripePaymentIntentId: intent.id });
        } catch (e) {
          db.prepare("UPDATE rides SET payment_status='failed' WHERE id=?").run(row.id);
          logEvent(row.id, "payment:failed", { reason: e.message });
          console.warn("Stripe charge failed for ride", row.id, ":", e.message);
        }
      }
    } else {
      // cash — nothing for Stripe to do; stays 'unpaid' as a reminder
      // this one was collected outside the app.
    }
  } else if (status === "cancelled") {
    db.prepare("UPDATE rides SET status=?, cancelled_at=datetime('now'), cancel_reason=? WHERE id=?")
      .run(status, reason || null, row.id);
  } else {
    db.prepare("UPDATE rides SET status=? WHERE id=?").run(status, row.id);
  }
  logEvent(row.id, "status:" + status, { by: req.user.id });

  if (status === "complete") {
    db.prepare(
      "UPDATE driver_profiles SET trips_count = trips_count + 1, updated_at = datetime('now') WHERE user_id = ?"
    ).run(row.driver_id);
  }

  const updated = db.prepare("SELECT * FROM rides WHERE id = ?").get(row.id);
  req.app.get("io").to("ride:" + row.id).emit("ride:updated", shapeRide(updated));
  res.json({ ride: shapeForRole(updated, req.user.role, req.user.id) });
});

router.post("/:id/dispute", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  const isParticipant = row.rider_id === req.user.id || row.driver_id === req.user.id;
  if (!isParticipant) return res.status(403).json({ error: "Not your ride." });

  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: "reason is required." });

  const id = uuid();
  db.prepare("INSERT INTO disputes (id, ride_id, raised_by, reason) VALUES (?, ?, ?, ?)")
    .run(id, row.id, req.user.id, reason);
  res.status(201).json({ disputeId: id });
});

module.exports = router;
