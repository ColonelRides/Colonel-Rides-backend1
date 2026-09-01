// Fare-calculation tests for the ZIPP frontend.
//
// These extract quoteFare/discountedTotal DIRECTLY from the live
// index.html at run time — not a hand-copied duplicate — so a future
// edit to the real fare logic gets tested automatically instead of
// silently drifting out of sync with a stale copy sitting in this file.
//
// Run with: node --test test/fare.test.js
// No install needed — uses Node's built-in test runner (Node 18+).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Path to the frontend's index.html. Backend and frontend deploy to
// completely separate places (Render vs Netlify) — there's no assumed
// shared folder layout — so this is configurable via an env var instead
// of a hardcoded relative path. Defaults to a sibling "zipp-frontend"
// folder, which you can override however your machine is actually laid out:
//   FRONTEND_HTML_PATH=/path/to/index.html node --test test/fare.test.js
const FRONTEND_PATH = process.env.FRONTEND_HTML_PATH
  || path.join(__dirname, "..", "..", "zipp-frontend", "index.html");

function extractSource() {
  if (!fs.existsSync(FRONTEND_PATH)) {
    throw new Error(
      `Can't find the frontend's index.html at ${FRONTEND_PATH}\n` +
      `Set FRONTEND_HTML_PATH to point at your actual index.html, e.g.:\n` +
      `  FRONTEND_HTML_PATH=/path/to/index.html node --test test/fare.test.js`
    );
  }
  const html = fs.readFileSync(FRONTEND_PATH, "utf8");

  const miMatch = html.match(/const mi = m => m \/ 1609\.34;/);
  const fareMatch = html.match(/fare:\s*\{[^}]*\}/);
  const quoteFareMatch = html.match(/function quoteFare\([^)]*\)\{[\s\S]*?\n\}/);
  const discountedTotalMatch = html.match(/function discountedTotal\([^)]*\)\{[\s\S]*?\n\}/);

  if (!miMatch) throw new Error("Couldn't find mi() in index.html — has it moved or been renamed?");
  if (!fareMatch) throw new Error("Couldn't find CFG.fare in index.html — has it moved or been renamed?");
  if (!quoteFareMatch) throw new Error("Couldn't find quoteFare() in index.html — has it moved or been renamed?");
  if (!discountedTotalMatch) throw new Error("Couldn't find discountedTotal() in index.html — has it moved or been renamed?");

  return {
    mi: miMatch[0],
    fare: fareMatch[0],
    quoteFare: quoteFareMatch[0],
    discountedTotal: discountedTotalMatch[0],
  };
}

function loadLiveFareModule() {
  const src = extractSource();
  const wrapped = `
    ${src.mi}
    const CFG = { ${src.fare} };
    ${src.quoteFare}
    ${src.discountedTotal}
    module.exports = { quoteFare, discountedTotal, CFG };
  `;
  const Module = require("node:module");
  const m = new Module(FRONTEND_PATH);
  m._compile(wrapped, "extracted-fare-logic.js");
  return m.exports;
}

const { quoteFare, discountedTotal, CFG } = loadLiveFareModule();

test("quoteFare — a standard one-way ride matches the flat-rate formula by hand", () => {
  // 5 miles, 12 minutes, standard tier, one-way, no wait
  const meters = 5 * 1609.34;
  const seconds = 12 * 60;
  const tier = { mult: 1.0 };
  const f = quoteFare(meters, seconds, tier, false, 0);

  const expectedBase = CFG.fare.base;
  const expectedDist = 5 * CFG.fare.perMile;
  const expectedTime = 12 * CFG.fare.perMin;
  const expectedRide = Math.max(expectedBase + expectedDist + expectedTime, CFG.fare.minimum);
  const expectedTotal = expectedRide + CFG.fare.service;

  assert.ok(Math.abs(f.total - expectedTotal) < 0.01, `expected total ~${expectedTotal}, got ${f.total}`);
  assert.equal(f.roundTrip, false);
  assert.equal(f.waitFee, 0);
});

test("quoteFare — never charges less than the minimum fare, even for a very short trip", () => {
  const f = quoteFare(200, 60, { mult: 1.0 }, false, 0); // ~0.12 miles, 1 minute
  const rideOnly = f.total - CFG.fare.service;
  assert.ok(rideOnly >= CFG.fare.minimum - 0.001, `ride portion ${rideOnly} fell below the minimum ${CFG.fare.minimum}`);
});

test("quoteFare — XL tier multiplies the base/distance/time components, but not the flat service fee", () => {
  const meters = 5 * 1609.34, seconds = 12 * 60;
  const std = quoteFare(meters, seconds, { mult: 1.0 }, false, 0);
  const xl = quoteFare(meters, seconds, { mult: 1.55 }, false, 0);

  assert.ok(Math.abs(xl.base - std.base * 1.55) < 0.01, "base should scale by the tier multiplier");
  assert.equal(xl.service, std.service, "the flat service fee should NOT scale with tier");
});

test("quoteFare — round trip doubles base/distance/time and can add a wait fee past the grace period", () => {
  const meters = 5 * 1609.34, seconds = 12 * 60;
  const oneWay = quoteFare(meters, seconds, { mult: 1.0 }, false, 0);
  const roundTrip = quoteFare(meters, seconds, { mult: 1.0 }, true, 0);
  assert.ok(Math.abs(roundTrip.base - oneWay.base * 2) < 0.01, "round trip should double the base fare");

  const withWait = quoteFare(meters, seconds, { mult: 1.0 }, true, CFG.fare.waitGraceMin + 5);
  assert.ok(withWait.waitFee > 0, "wait past the grace period should incur a fee");
  assert.ok(Math.abs(withWait.waitFee - 5 * CFG.fare.waitPerMin) < 0.01, "wait fee should only bill minutes past the grace period");

  const withinGrace = quoteFare(meters, seconds, { mult: 1.0 }, true, CFG.fare.waitGraceMin - 2);
  assert.equal(withinGrace.waitFee, 0, "wait fully inside the grace period should be free");
});

test("discountedTotal — a percent-style promo reduces the total by exactly that amount", () => {
  const f = { total: 20.00 };
  const result = discountedTotal(f, 500, 0); // $5.00 off in cents
  assert.equal(result, 15.00);
});

test("discountedTotal — promo and credit stack, but never take the total below zero", () => {
  const f = { total: 8.00 };
  const result = discountedTotal(f, 500, 1000); // $5 promo + $10 credit on an $8 ride
  assert.equal(result, 0, "should floor at $0, never go negative");
});

test("discountedTotal — credit is capped at whatever's left after the promo, not the full fare", () => {
  const f = { total: 20.00 };
  // $5 promo brings it to $15; a $1000 credit should only ever cover that
  // remaining $15, not somehow discount below zero or ignore the promo.
  const result = discountedTotal(f, 500, 100000);
  assert.equal(result, 0);
});

test("discountedTotal — with no promo or credit, returns the original total unchanged", () => {
  const f = { total: 12.34 };
  assert.equal(discountedTotal(f, 0, 0), 12.34);
  assert.equal(discountedTotal(f, null, null), 12.34);
});
