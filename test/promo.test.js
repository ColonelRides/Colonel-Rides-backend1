// Tests for promo code validation/discount math — the exact function
// both POST /api/promo/validate and ride creation rely on to decide
// whether a code is valid and what it's worth.
//
// This imports the real, live lib/promoLogic.js (not a copy), and has
// zero dependency on better-sqlite3 or express, so it runs instantly
// with nothing to install:
//   node --test test/promo.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePromoCode } = require("../lib/promoLogic");

function makeCode(overrides = {}) {
  return {
    code: "TESTCODE",
    discount_type: "percent",
    discount_value: 10,
    max_uses: null,
    uses_count: 0,
    per_user_limit: 1,
    expires_at: null,
    active: 1,
    ...overrides,
  };
}

test("rejects a code that doesn't exist", () => {
  const result = evaluatePromoCode(null, 2000, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't valid/);
});

test("rejects a deactivated code", () => {
  const result = evaluatePromoCode(makeCode({ active: 0 }), 2000, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't valid/);
});

test("rejects an expired code", () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const result = evaluatePromoCode(makeCode({ expires_at: yesterday }), 2000, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
});

test("accepts a code that expires in the future", () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const result = evaluatePromoCode(makeCode({ expires_at: tomorrow }), 2000, 0);
  assert.equal(result.ok, true);
});

test("rejects a code that's hit its total redemption cap", () => {
  const result = evaluatePromoCode(makeCode({ max_uses: 50, uses_count: 50 }), 2000, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /fully redeemed/);
});

test("accepts a code with uses remaining under its cap", () => {
  const result = evaluatePromoCode(makeCode({ max_uses: 50, uses_count: 49 }), 2000, 0);
  assert.equal(result.ok, true);
});

test("a null max_uses means unlimited — never blocked no matter how many uses", () => {
  const result = evaluatePromoCode(makeCode({ max_uses: null, uses_count: 999999 }), 2000, 0);
  assert.equal(result.ok, true);
});

test("rejects a rider who's already used this code as many times as their personal limit allows", () => {
  const result = evaluatePromoCode(makeCode({ per_user_limit: 1 }), 2000, /* usedByThisUser */ 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /already used/);
});

test("allows a rider under their personal per-use limit", () => {
  const result = evaluatePromoCode(makeCode({ per_user_limit: 3 }), 2000, /* usedByThisUser */ 2);
  assert.equal(result.ok, true);
});

test("percent discount is computed correctly and rounded to the nearest cent", () => {
  const result = evaluatePromoCode(makeCode({ discount_type: "percent", discount_value: 15 }), 2333, 0);
  assert.equal(result.ok, true);
  assert.equal(result.discountCents, Math.round(2333 * 0.15)); // 350
});

test("flat discount ignores the fare amount entirely, up to the fare's own size", () => {
  const result = evaluatePromoCode(makeCode({ discount_type: "flat", discount_value: 500 }), 2000, 0);
  assert.equal(result.ok, true);
  assert.equal(result.discountCents, 500);
});

test("a discount can never exceed the fare itself — a $10 flat code on a $4 ride caps at $4", () => {
  const result = evaluatePromoCode(makeCode({ discount_type: "flat", discount_value: 1000 }), 400, 0);
  assert.equal(result.ok, true);
  assert.equal(result.discountCents, 400, "discount should be capped at the fare, not exceed it");
});

test("a 100%-off percent code fully covers the fare, never more", () => {
  const result = evaluatePromoCode(makeCode({ discount_type: "percent", discount_value: 100 }), 1599, 0);
  assert.equal(result.ok, true);
  assert.equal(result.discountCents, 1599);
});

test("the returned code is the canonical stored code, not whatever casing the rider typed", () => {
  const result = evaluatePromoCode(makeCode({ code: "WELCOME10" }), 2000, 0);
  assert.equal(result.code, "WELCOME10");
});
               
