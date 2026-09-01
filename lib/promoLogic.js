// Pure promo-code evaluation logic, deliberately kept free of any
// dependency on express, the database, or anything else that needs
// installing — this is what decides whether a code is valid and what
// it's worth, given plain values the caller already looked up.
//
// Kept in its own file (rather than inline in routes/promo.js) so it can
// be unit-tested directly — see test/promo.test.js — without needing a
// real SQLite database or better-sqlite3's native bindings at all.
function evaluatePromoCode(row, fareCents, usedByThisUser) {
  if (!row || !row.active) return { ok: false, error: "That code isn't valid." };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, error: "That code has expired." };
  if (row.max_uses != null && row.uses_count >= row.max_uses) return { ok: false, error: "That code has been fully redeemed." };
  if (usedByThisUser >= row.per_user_limit) return { ok: false, error: "You've already used this code." };

  const discount = row.discount_type === "percent"
    ? Math.round(fareCents * (row.discount_value / 100))
    : row.discount_value;
  const cappedDiscount = Math.min(discount, fareCents);

  return { ok: true, code: row.code, discountCents: cappedDiscount };
}

module.exports = { evaluatePromoCode };
