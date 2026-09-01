const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { stripe } = require("./payments");
const { checkCode } = require("./promo");
const push = require("../lib/push");
const { sendMail } = require("../lib/mailer");

const router = express.Router();

const REFERRAL_BONUS_CENTS = Number(process.env.REFERRAL_BONUS_CENTS || 500); // $5, each side

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
    promoCode: row.promo_code,
    discountCents: row.discount_cents || 0,
    creditAppliedCents: row.credit_applied_cents || 0,
    tipCents: row.tip_cents,
    driverTakeCents: row.driver_take_cents,
    driverPayStatus: row.driver_pay_status,
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

router.post("/", requireAuth, requireRole("rider"), async (req, res) => {
  const b = req.body || {};
  const { pickup, dest, tier, distanceMiles, durationMin, fareCents, paymentMethod, scheduledFor, promoCode, useCreditCents } = b;

  if (!pickup || !dest || !["std", "xl", "now"].includes(tier) || !fareCents) {
    return res.status(400).json({ error: "pickup, dest, tier, and fareCents are required." });
  }
  if (!inArea(pickup.lat, pickup.lng)) {
    return res.status(400).json({ error: "Pickup is outside the service area." });
  }

  const isCash = paymentMethod === "cash";
  const fareCentsRounded = Math.round(fareCents);
  const rider = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

  // Discount amounts are always computed here from server-side records
  // (the promo_codes table, the rider's own credit_cents balance) —
  // never trusted from the client, even though the base fare currently
  // still is. A promo/credit combo can discount a ride to $0 but never
  // below it.
  let discountCents = 0, promoCodeApplied = null;
  if (promoCode) {
    const result = checkCode(promoCode, fareCentsRounded, req.user.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    discountCents = result.discountCents;
    promoCodeApplied = result.code;
  }
  const remainingAfterPromo = Math.max(0, fareCentsRounded - discountCents);
  const creditAvailable = rider.credit_cents || 0;
  const creditToApply = Math.min(Math.max(0, Math.round(useCreditCents || 0)), creditAvailable, remainingAfterPromo);
  const finalFareCents = Math.max(0, remainingAfterPromo - creditToApply);

  // Charge BEFORE the ride is created — if the card can't be charged,
  // the rider should find out immediately, not end up with a ride a
  // driver already accepted only for payment to fail afterward.
  let paymentIntentId = null;
  let paymentStatus = "unpaid";
  if (isCash) {
    // cash rides skip Stripe entirely, same as before
  } else if (finalFareCents <= 0) {
    // Fully covered by promo + credit — nothing to charge Stripe for.
    paymentStatus = "paid";
  } else {
    if (!stripe) {
      return res.status(503).json({ error: "Payments aren't configured on this server yet." });
    }
    if (!rider.stripe_customer_id || !rider.stripe_payment_method_id) {
      return res.status(400).json({ error: "Add a card before requesting a ride." });
    }
    try {
      const intent = await stripe.paymentIntents.create({
        amount: finalFareCents,
        currency: "usd",
        customer: rider.stripe_customer_id,
        payment_method: rider.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: { rider_id: req.user.id },
      });
      paymentIntentId = intent.id;
      paymentStatus = "paid";
    } catch (e) {
      console.warn("Stripe charge failed at request time:", e.message);
      return res.status(402).json({ error: "Your card was declined: " + e.message });
    }
  }

  const ride = {
    id: uuid(),
    rider_id: req.user.id,
    tier,
    pickup_lat: pickup.lat, pickup_lng: pickup.lng, pickup_label: pickup.label || "Pickup",
    dest_lat: dest.lat, dest_lng: dest.lng, dest_label: dest.label || "Destination",
    distance_miles: distanceMiles || 0,
    duration_min: durationMin || 0,
    fare_cents: fareCentsRounded, // full fare before any discount, kept for the receipt
    promo_code: promoCodeApplied,
    discount_cents: discountCents,
    credit_applied_cents: creditToApply,
    payment_method: isCash ? "cash" : "card",
    payment_status: paymentStatus,
    stripe_payment_intent_id: paymentIntentId,
    pin: String(Math.floor(1000 + Math.random() * 9000)),
    scheduled_for: scheduledFor || null,
  };
  db.prepare(
    `INSERT INTO rides (id, rider_id, tier, pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,
                         distance_miles, duration_min, fare_cents, promo_code, discount_cents, credit_applied_cents,
                         payment_method, payment_status, stripe_payment_intent_id, pin, scheduled_for)
     VALUES (@id, @rider_id, @tier, @pickup_lat, @pickup_lng, @pickup_label, @dest_lat, @dest_lng, @dest_label,
             @distance_miles, @duration_min, @fare_cents, @promo_code, @discount_cents, @credit_applied_cents,
             @payment_method, @payment_status, @stripe_payment_intent_id, @pin, @scheduled_for)`
  ).run(ride);
  logEvent(ride.id, "requested", { tier, fareCents: ride.fare_cents, discountCents, creditToApply, paymentStatus });
  if (paymentIntentId) logEvent(ride.id, "payment:charged", { stripePaymentIntentId: paymentIntentId });

  if (promoCodeApplied) {
    db.prepare("INSERT INTO promo_redemptions (id, code, user_id, ride_id, discount_cents) VALUES (?, ?, ?, ?, ?)")
      .run(uuid(), promoCodeApplied, req.user.id, ride.id, discountCents);
    db.prepare("UPDATE promo_codes SET uses_count = uses_count + 1 WHERE code = ?").run(promoCodeApplied);
  }
  if (creditToApply > 0) {
    db.prepare("UPDATE users SET credit_cents = credit_cents - ? WHERE id = ?").run(creditToApply, req.user.id);
    db.prepare(
      "INSERT INTO referral_credits (id, user_id, amount_cents, reason, ride_id) VALUES (?, ?, ?, 'ride_credit_applied', ?)"
    ).run(uuid(), req.user.id, -creditToApply, ride.id);
  }

  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(ride.id);

  // Tell every online driver in the service area a ride is up for grabs.
  // A real dispatch would rank by distance/ETA instead of broadcasting
  // to everyone; fine for a four-town launch, worth revisiting once
  // you have more than a handful of drivers online at once.
  req.app.get("io").to("drivers:online").emit("ride:new", shapeRide(row));

  // Push is a backup channel for drivers who have the app closed or
  // backgrounded — Socket.IO above already covers anyone with it open.
  const onlineDriverIds = db.prepare("SELECT user_id FROM driver_profiles WHERE is_online = 1").all().map(d => d.user_id);
  if (onlineDriverIds.length) {
    push.sendToUsers(onlineDriverIds, { title: "New ride request", body: `Pickup near ${ride.pickup_label}` }).catch(() => {});
  }

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
  push.sendToUser(row.rider_id, { title: "Driver on the way", body: `${driver.name} accepted your ride and is heading your way.` }).catch(() => {});
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

  // Checked before this ride's own row flips to 'complete' below, so a
  // rider's very first completed ride doesn't accidentally count itself.
  const isRidersFirstCompletedRide = status === "complete" && db.prepare(
    "SELECT COUNT(*) n FROM rides WHERE rider_id = ? AND status = 'complete' AND id != ?"
  ).get(row.rider_id, row.id).n === 0;

  if (status === "onTrip") {
    db.prepare("UPDATE rides SET status=?, started_at=datetime('now') WHERE id=?").run(status, row.id);
  } else if (status === "complete") {
    const driverTake = Math.round(row.fare_cents * 0.78);
    db.prepare("UPDATE rides SET status=?, completed_at=datetime('now'), driver_take_cents=? WHERE id=?")
      .run(status, driverTake, row.id);
    // Payment already happened at request time — nothing to charge here.

    // Real payout: if the driver has finished Stripe Connect onboarding,
    // move their cut to their own bank account via a Transfer. If not,
    // fall back to the existing manual-payout tracking (Venmo/Zelle,
    // paid out by the operator by hand) rather than blocking completion.
    const driverProfile = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(row.driver_id);
    if (stripe && driverProfile && driverProfile.stripe_connect_status === "active" && driverProfile.stripe_connect_account_id) {
      try {
        const transfer = await stripe.transfers.create({
          amount: driverTake,
          currency: "usd",
          destination: driverProfile.stripe_connect_account_id,
          transfer_group: "ride_" + row.id,
        });
        db.prepare("UPDATE rides SET stripe_transfer_id=?, driver_pay_status='paid' WHERE id=?").run(transfer.id, row.id);
        logEvent(row.id, "payout:transferred", { stripeTransferId: transfer.id, amount: driverTake });
      } catch (e) {
        console.warn("Driver transfer failed for ride", row.id, ":", e.message);
        db.prepare("UPDATE rides SET driver_pay_status='failed' WHERE id=?").run(row.id);
        logEvent(row.id, "payout:transfer_failed", { reason: e.message });
      }
    } else {
      db.prepare("UPDATE rides SET driver_pay_status='manual' WHERE id=?").run(row.id);
    }

    // Referral bonus: both sides get credit, but only once the referred
    // rider has actually completed a real ride — not just for signing up,
    // which would be trivial to farm.
    if (isRidersFirstCompletedRide) {
      const rider = db.prepare("SELECT * FROM users WHERE id = ?").get(row.rider_id);
      if (rider && rider.referred_by) {
        db.prepare("UPDATE users SET credit_cents = credit_cents + ? WHERE id = ?").run(REFERRAL_BONUS_CENTS, rider.id);
        db.prepare("INSERT INTO referral_credits (id, user_id, amount_cents, reason, ride_id) VALUES (?, ?, ?, 'referral_signup_bonus', ?)")
          .run(uuid(), rider.id, REFERRAL_BONUS_CENTS, row.id);

        db.prepare("UPDATE users SET credit_cents = credit_cents + ? WHERE id = ?").run(REFERRAL_BONUS_CENTS, rider.referred_by);
        db.prepare("INSERT INTO referral_credits (id, user_id, amount_cents, reason, ride_id) VALUES (?, ?, ?, 'referral_referrer_bonus', ?)")
          .run(uuid(), rider.referred_by, REFERRAL_BONUS_CENTS, row.id);

        push.sendToUser(rider.referred_by, {
          title: "You earned ZIPP credit!",
          body: `Someone you referred just took their first ride — $${(REFERRAL_BONUS_CENTS / 100).toFixed(2)} credit is on your account.`,
        }).catch(() => {});
      }
    }

    // Receipt email — best-effort, same as verification/reset mail: logs
    // to console instead of sending if SMTP isn't configured, and never
    // blocks the response either way.
    (async () => {
      const rider = db.prepare("SELECT * FROM users WHERE id = ?").get(row.rider_id);
      if (!rider) return;
      const totalCents = Math.max(0, row.fare_cents - (row.discount_cents || 0) - (row.credit_applied_cents || 0));
      const lines = [
        `Thanks for riding with ZIPP, ${rider.name}!`,
        ``,
        `${row.pickup_label} → ${row.dest_label}`,
        `Fare: $${(row.fare_cents / 100).toFixed(2)}`,
      ];
      if (row.discount_cents) lines.push(`Promo (${row.promo_code || ""}): -$${(row.discount_cents / 100).toFixed(2)}`);
      if (row.credit_applied_cents) lines.push(`ZIPP credit applied: -$${(row.credit_applied_cents / 100).toFixed(2)}`);
      lines.push(`Total charged: $${(totalCents / 100).toFixed(2)}`);
      if (row.tip_cents) lines.push(`Tip: $${(row.tip_cents / 100).toFixed(2)}`);
      lines.push(``, `See you next ride.`);

      await sendMail({
        to: rider.email,
        subject: "Your ZIPP receipt",
        text: lines.join("\n"),
      });
    })().catch((e) => console.warn("Receipt email failed for ride", row.id, ":", e.message));
  } else if (status === "cancelled") {
    db.prepare("UPDATE rides SET status=?, cancelled_at=datetime('now'), cancel_reason=? WHERE id=?")
      .run(status, reason || null, row.id);

    // Already charged at request time — a cancellation now needs a
    // real refund, not just a status change, or the rider's been
    // charged for a ride that never happened.
    if (row.payment_status === "paid" && row.stripe_payment_intent_id && stripe) {
      try {
        await stripe.refunds.create({ payment_intent: row.stripe_payment_intent_id });
        db.prepare("UPDATE rides SET payment_status='refunded' WHERE id=?").run(row.id);
        logEvent(row.id, "payment:refunded", { stripePaymentIntentId: row.stripe_payment_intent_id });
      } catch (e) {
        console.warn("Refund failed for ride", row.id, ":", e.message);
        logEvent(row.id, "payment:refund_failed", { reason: e.message });
      }
    }
    // Credit isn't a Stripe charge — it's the platform's own balance —
    // so it's restored directly rather than through a refund API call.
    if (row.credit_applied_cents > 0) {
      db.prepare("UPDATE users SET credit_cents = credit_cents + ? WHERE id = ?").run(row.credit_applied_cents, row.rider_id);
      db.prepare("INSERT INTO referral_credits (id, user_id, amount_cents, reason, ride_id) VALUES (?, ?, ?, 'ride_credit_applied', ?)")
        .run(uuid(), row.rider_id, row.credit_applied_cents, row.id);
      logEvent(row.id, "credit:restored", { amountCents: row.credit_applied_cents });
    }
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

  // Push, same as Socket.IO above, is best-effort and never allowed to
  // affect the response — it's purely a backup channel for a
  // backgrounded/closed app.
  const PUSH_BY_STATUS = {
    arriving: { to: row.rider_id, title: "Your driver is close", body: "They're on their way to your pickup spot." },
    arrived: { to: row.rider_id, title: "Your driver has arrived", body: "Head out whenever you're ready." },
    complete: { to: row.rider_id, title: "Ride complete", body: `You were charged $${(row.fare_cents / 100).toFixed(2)}. Thanks for riding with ZIPP!` },
    cancelled: { to: req.user.id === row.driver_id ? row.rider_id : row.driver_id, title: "Ride cancelled", body: reason || "The ride was cancelled." },
  };
  const notif = PUSH_BY_STATUS[status];
  if (notif && notif.to) push.sendToUser(notif.to, { title: notif.title, body: notif.body }).catch(() => {});

  res.json({ ride: shapeForRole(updated, req.user.role, req.user.id) });
});


// Tips are their own charge — a separate PaymentIntent, added after the
// ride's own fare is already settled, using the same saved card.
router.post("/:id/tip", requireAuth, requireRole("rider"), async (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  if (row.rider_id !== req.user.id) return res.status(403).json({ error: "Not your ride." });
  if (row.status !== "complete") return res.status(409).json({ error: "Can only tip a completed ride." });
  if (row.tip_cents) return res.statu    
