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

module.exports = router;
