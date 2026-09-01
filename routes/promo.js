const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { evaluatePromoCode } = require("../lib/promoLogic");

const router = express.Router();

// Computes the discount a code is worth against a given fare, without
// applying it to anything. Shared by the /validate endpoint below and by
// ride creation (routes/rides.js), so the exact same rules decide what a
// rider sees at checkout and what they're actually charged.
function checkCode(code, fareCents, userId) {
  const row = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(String(code || "").toUpperCase().trim());
  const usedByThisUser = row
    ? db.prepare("SELECT COUNT(*) n FROM promo_redemptions WHERE code = ? AND user_id = ?").get(row.code, userId).n
    : 0;
  return evaluatePromoCode(row, fareCents, usedByThisUser);
}

// Computes the discount a code is worth against a given fare, without
// applying it to anything. Shared by the /validate endpoint below and by
// ride creation (routes/rides.js), so the exact same rules decide what a
// rider sees at checkout and what they're actually charged.
function checkCode(code, fareCents, userId) {
  const row = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(String(code || "").toUpperCase().trim());
  const usedByThisUser = row
    ? db.prepare("SELECT COUNT(*) n FROM promo_redemptions WHERE code = ? AND user_id = ?").get(row.code, userId).n
    : 0;
  return evaluatePromoCode(row, fareCents, usedByThisUser);
}

router.post("/validate", requireAuth, requireRole("rider"), (req, res) => {
  const { code, fareCents } = req.body || {};
  if (!code || !fareCents) return res.status(400).json({ error: "code and fareCents are required." });

  const result = checkCode(code, Math.round(fareCents), req.user.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ code: result.code, discountCents: result.discountCents, newFareCents: Math.round(fareCents) - result.discountCents });
});

module.exports = { router, checkCode, evaluatePromoCode };
