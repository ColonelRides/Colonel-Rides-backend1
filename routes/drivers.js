const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function shapeProfile(row, name) {
  if (!row) return null;
  return {
    status: row.status,
    rejectionNote: row.rejection_note || null,
    name,
    dob: row.dob,
    city: row.city,
    photo: row.photo_url,
    vehicle: {
      year: row.vehicle_year,
      make: row.vehicle_make,
      model: row.vehicle_model,
      color: row.vehicle_color,
      plate: row.vehicle_plate,
      seats: row.vehicle_seats,
    },
    payout: { method: row.payout_method, last4: row.payout_last4, brand: row.payout_brand },
    rating: row.rating,
    tripsCount: row.trips_count,
    isOnline: !!row.is_online,
  };
}

function validateApplication(b) {
  const errs = [];
  if (!b.dob) errs.push("Date of birth is required.");
  if (!b.city) errs.push("City is required.");
  const v = b.vehicle || {};
  if (!v.year || v.year < 2008) errs.push("Vehicle must be 2008 or newer.");
  if (!v.make || !v.model) errs.push("Vehicle make and model are required.");
  if (!v.plate) errs.push("License plate is required.");
  if (!v.seats) errs.push("Seat count is required.");
  const p = b.payout || {};
  if (!["bank", "debit"].includes(p.method)) errs.push("Payout method must be 'bank' or 'debit'.");
  if (!p.last4) errs.push("Payout last4 is required.");
  if (!b.ssn4 || !/^\d{4}$/.test(b.ssn4)) errs.push("A valid last-4 SSN is required for tax reporting.");
  return errs;
}

// First-time submission. Always resets status to "pending" — a real
// background check (Checkr) and payout verification (Stripe Connect)
// should be triggered from here via webhook, with this row updated
// when that provider calls back rather than approved instantly.
router.post("/apply", requireAuth, requireRole("driver"), (req, res) => {
  const b = req.body || {};
  const errs = validateApplication(b);
  if (errs.length) return res.status(400).json({ error: errs.join(" ") });

  const v = b.vehicle, p = b.payout;
  db.prepare(
    `INSERT INTO driver_profiles
       (user_id, dob, city, photo_url, vehicle_year, vehicle_make, vehicle_model, vehicle_color,
        vehicle_plate, vehicle_seats, payout_method, payout_last4, payout_brand, ssn_last4, status, updated_at)
     VALUES (@user_id, @dob, @city, @photo_url, @vehicle_year, @vehicle_make, @vehicle_model, @vehicle_color,
             @vehicle_plate, @vehicle_seats, @payout_method, @payout_last4, @payout_brand, @ssn_last4, 'pending', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
        dob=excluded.dob, city=excluded.city, photo_url=excluded.photo_url,
        vehicle_year=excluded.vehicle_year, vehicle_make=excluded.vehicle_make, vehicle_model=excluded.vehicle_model,
        vehicle_color=excluded.vehicle_color, vehicle_plate=excluded.vehicle_plate, vehicle_seats=excluded.vehicle_seats,
        payout_method=excluded.payout_method, payout_last4=excluded.payout_last4, payout_brand=excluded.payout_brand,
        ssn_last4=excluded.ssn_last4, status='pending', rejection_note=NULL, updated_at=datetime('now')`
  ).run({
    user_id: req.user.id, dob: b.dob, city: b.city, photo_url: b.photo || null,
    vehicle_year: v.year, vehicle_make: v.make, vehicle_model: v.model, vehicle_color: v.color || "",
    vehicle_plate: v.plate, vehicle_seats: v.seats, payout_method: p.method,
    payout_last4: p.last4, payout_brand: p.brand || null, ssn_last4: b.ssn4,
  });

  const row = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.user.id);
  res.status(201).json({ profile: shapeProfile(row, user.name) });
});

router.get("/me", requireAuth, requireRole("driver"), (req, res) => {
  const row = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.user.id);
  if (!row) return res.status(404).json({ error: "No application on file yet." });
  res.json({ profile: shapeProfile(row, user.name) });
});

// Edits after approval — does not reset status back to pending.
router.patch("/me", requireAuth, requireRole("driver"), (req, res) => {
  const existing = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
  if (!existing) return res.status(404).json({ error: "No application on file yet." });

  const b = req.body || {};
  const v = b.vehicle || {};
  const p = b.payout || {};
  db.prepare(
    `UPDATE driver_profiles SET
       dob=@dob, city=@city, photo_url=@photo_url,
       vehicle_year=@vehicle_year, vehicle_make=@vehicle_make, vehicle_model=@vehicle_model,
       vehicle_color=@vehicle_color, vehicle_plate=@vehicle_plate, vehicle_seats=@vehicle_seats,
       payout_method=@payout_method, payout_last4=@payout_last4, payout_brand=@payout_brand,
       updated_at=datetime('now')
     WHERE user_id=@user_id`
  ).run({
    user_id: req.user.id,
    dob: b.dob ?? existing.dob, city: b.city ?? existing.city, photo_url: b.photo ?? existing.photo_url,
    vehicle_year: v.year ?? existing.vehicle_year, vehicle_make: v.make ?? existing.vehicle_make,
    vehicle_model: v.model ?? existing.vehicle_model, vehicle_color: v.color ?? existing.vehicle_color,
    vehicle_plate: v.plate ?? existing.vehicle_plate, vehicle_seats: v.seats ?? existing.vehicle_seats,
    payout_method: p.method ?? existing.payout_method, payout_last4: p.last4 ?? existing.payout_last4,
    payout_brand: p.brand ?? existing.payout_brand,
  });

  const row = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.user.id);
  res.json({ profile: shapeProfile(row, user.name) });
});

// Toggle online/offline + report a location tick. The location half of
// this is also sent over the socket for anything needing sub-second
// updates (live tracking); this REST call is what persists last-known
// position for reconnects and for the admin map.
router.post("/online", requireAuth, requireRole("driver"), (req, res) => {
  const { online, lat, lng } = req.body || {};
  db.prepare(
    "UPDATE driver_profiles SET is_online=?, last_lat=COALESCE(?, last_lat), last_lng=COALESCE(?, last_lng), updated_at=datetime('now') WHERE user_id=?"
  ).run(online ? 1 : 0, lat ?? null, lng ?? null, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
