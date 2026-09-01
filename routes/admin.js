const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

router.get("/stats", (req, res) => {
  const pendingDrivers = db.prepare("SELECT COUNT(*) n FROM driver_profiles WHERE status='pending'").get().n;
  const onlineDrivers = db.prepare("SELECT COUNT(*) n FROM driver_profiles WHERE is_online=1").get().n;
  const liveRides = db.prepare("SELECT COUNT(*) n FROM rides WHERE status NOT IN ('complete','cancelled')").get().n;
  const openDisputes = db.prepare("SELECT COUNT(*) n FROM disputes WHERE status='open'").get().n;
  const ridesToday = db.prepare(
    "SELECT COUNT(*) n FROM rides WHERE date(requested_at) = date('now')"
  ).get().n;
  const grossToday = db.prepare(
    "SELECT COALESCE(SUM(fare_cents),0) c FROM rides WHERE status='complete' AND date(completed_at) = date('now')"
  ).get().c;
  res.json({ pendingDrivers, onlineDrivers, liveRides, openDisputes, ridesToday, grossCentsToday: grossToday });
});

router.get("/drivers/pending", (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, d.*
     FROM driver_profiles d JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending' ORDER BY d.created_at ASC`
  ).all();
  res.json({ drivers: rows });
});

router.get("/drivers", (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, d.*
     FROM driver_profiles d JOIN users u ON u.id = d.user_id
     ORDER BY d.created_at DESC LIMIT 200`
  ).all();
  res.json({ drivers: rows });
});

router.patch("/drivers/:userId/approve", (req, res) => {
  const info = db.prepare(
    "UPDATE driver_profiles SET status='approved', rejection_note=NULL, updated_at=datetime('now') WHERE user_id=?"
  ).run(req.params.userId);
  if (info.changes === 0) return res.status(404).json({ error: "No application found for that user." });
  res.json({ ok: true });
});

router.patch("/drivers/:userId/reject", (req, res) => {
  const { reason } = req.body || {};
  const info = db.prepare(
    "UPDATE driver_profiles SET status='rejected', rejection_note=?, updated_at=datetime('now') WHERE user_id=?"
  ).run(reason || null, req.params.userId);
  if (info.changes === 0) return res.status(404).json({ error: "No application found for that user." });
  res.json({ ok: true });
});

// Permanently removes a driver's account. Deliberately more cautious than
// deleting a ride: ride history is detached (driver_id set to NULL, so
// past rides stay on record as "Unassigned" rather than vanishing) rather
// than deleted outright, and the delete is refused — not silently
// cascaded — if it would destroy dispute records, since those are the
// kind of history you don't want an accidental tap to erase.
router.delete("/drivers/:userId", (req, res) => {
  const { userId } = req.params;
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(userId);
  if (!user) return res.status(404).json({ error: "No driver found with that id." });

  const disputeCount = db.prepare(
    "SELECT COUNT(*) n FROM disputes WHERE raised_by = ?"
  ).get(userId).n;
  if (disputeCount > 0) {
    return res.status(409).json({
      error: "This driver has raised or been party to a dispute, so their account can't be permanently deleted. Reject or deactivate them instead to keep that history intact.",
    });
  }

  const tx = db.transaction(() => {
    // Keep the ride records — just detach the driver reference so old
    // trips don't disappear from history, they just show as unassigned.
    db.prepare("UPDATE rides SET driver_id = NULL WHERE driver_id = ?").run(userId);
    db.prepare("DELETE FROM promo_redemptions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM referral_credits WHERE user_id = ?").run(userId);
    db.prepare("UPDATE users SET referred_by = NULL WHERE referred_by = ?").run(userId);
    // driver_profiles and push_subscriptions cascade automatically.
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });

  try {
    tx();
    res.json({ ok: true });
  } catch (e) {
    console.error("Driver delete failed:", e.message);
    res.status(409).json({ error: "Couldn't delete this driver — they still have linked records elsewhere." });
  }
});

router.get("/rides/live", (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, ru.name AS rider_name, du.name AS driver_name
     FROM rides r
     JOIN users ru ON ru.id = r.rider_id
     LEFT JOIN users du ON du.id = r.driver_id
     WHERE r.status NOT IN ('complete','cancelled')
     ORDER BY r.requested_at DESC`
  ).all();
  res.json({ rides: rows });
});

router.get("/rides", (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, ru.name AS rider_name, du.name AS driver_name
     FROM rides r
     JOIN users ru ON ru.id = r.rider_id
     LEFT JOIN users du ON du.id = r.driver_id
     ORDER BY r.requested_at DESC LIMIT 200`
  ).all();
  res.json({ rides: rows });
});

// Permanently removes a ride and everything tied specifically to it
// (disputes, promo redemptions, referral credits, event log — ride_events
// cascades automatically, the rest don't so they're cleaned up here).
// Meant for clearing out stale test/demo rides, not as an undo for a real
// completed trip — this does not touch Stripe or reverse any charge.
router.delete("/rides/:id", (req, res) => {
  const { id } = req.params;
  const ride = db.prepare("SELECT id FROM rides WHERE id = ?").get(id);
  if (!ride) return res.status(404).json({ error: "No ride found with that id." });

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM disputes WHERE ride_id = ?").run(id);
    db.prepare("DELETE FROM promo_redemptions WHERE ride_id = ?").run(id);
    db.prepare("DELETE FROM referral_credits WHERE ride_id = ?").run(id);
    // ride_events cascades automatically via ON DELETE CASCADE.
    db.prepare("DELETE FROM rides WHERE id = ?").run(id);
  });

  try {
    tx();
    res.json({ ok: true });
  } catch (e) {
    console.error("Ride delete failed:", e.message);
    res.status(409).json({ error: "Couldn't delete this ride — it still has linked records elsewhere." });
  }
});

router.get("/disputes", (req, res) => {
  const status = req.query.status; // "open" | "resolved" | undefined (= all)
  const rows = status
    ? db.prepare(
        `SELECT d.*, u.name AS raised_by_name FROM disputes d JOIN users u ON u.id = d.raised_by
         WHERE d.status = ? ORDER BY d.created_at DESC`
      ).all(status)
    : db.prepare(
        `SELECT d.*, u.name AS raised_by_name FROM disputes d JOIN users u ON u.id = d.raised_by
         ORDER BY d.created_at DESC`
      ).all();
  res.json({ disputes: rows });
});

router.patch("/disputes/:id/resolve", (req, res) => {
  const { note, refundCents } = req.body || {};
  const info = db.prepare(
    "UPDATE disputes SET status='resolved', resolution_note=?, refund_cents=?, resolved_at=datetime('now') WHERE id=?"
  ).run(note || null, refundCents ?? null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Dispute not found." });
  res.json({ ok: true });
});

router.get("/promo-codes", (req, res) => {
  const rows = db.prepare("SELECT * FROM promo_codes ORDER BY created_at DESC").all();
  res.json({ promoCodes: rows });
});

router.post("/promo-codes", (req, res) => {
  const { code, discountType, discountValue, maxUses, perUserLimit, expiresAt } = req.body || {};
  if (!code || !["percent", "flat"].includes(discountType) || !discountValue) {
    return res.status(400).json({ error: "code, discountType ('percent'|'flat'), and discountValue are required." });
  }
  const normalized = String(code).toUpperCase().trim();
  const existing = db.prepare("SELECT code FROM promo_codes WHERE code = ?").get(normalized);
  if (existing) return res.status(409).json({ error: "That code already exists." });

  db.prepare(
    `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, per_user_limit, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(normalized, discountType, Math.round(discountValue), maxUses ?? null, perUserLimit ?? 1, expiresAt || null);

  res.status(201).json({ ok: true, code: normalized });
});

router.patch("/promo-codes/:code/deactivate", (req, res) => {
  const info = db.prepare("UPDATE promo_codes SET active=0 WHERE code=?").run(req.params.code.toUpperCase());
  if (info.changes === 0) return res.status(404).json({ error: "Promo code not found." });
  res.json({ ok: true });
});

module.exports = router;
    
