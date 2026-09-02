const test = require("node:test");
const assert = require("node:assert/strict");
const { haversineMiles, safeDistanceAndDuration, quoteFareCents, computeAuthoritativeFareCents } = require("../lib/fareLogic");

test("quoteFareCents matches the frontend's math for a normal 5mi/12min standard ride", () => {
  // Same scenario already verified against the frontend in test/fare.test.js:
  // base 2.75 + 5mi*1.35 + 12min*0.32 = 2.75+6.75+3.84 = 13.34, above the $6.50 minimum
  // + $1.90 service = $15.24 = 1524 cents
  const cents = quoteFareCents({ distanceMiles: 5, durationMin: 12, tier: "std", roundTrip: false, waitMin: 0 });
  assert.equal(cents, 1524);
});

test("a very short ride is still charged the minimum fare, not less", () => {
  const cents = quoteFareCents({ distanceMiles: 0.2, durationMin: 1, tier: "std", roundTrip: false, waitMin: 0 });
  // $6.50 minimum + $1.90 service = $8.40
  assert.equal(cents, 840);
});

test("haversineMiles gives a sane straight-line distance for a real short hop", () => {
  // Richmond, KY to Berea, KY is roughly 12-13 miles apart
  const miles = haversineMiles(37.7479, -84.2947, 37.5687, -84.2963);
  assert.ok(miles > 10 && miles < 16, `expected ~12-13mi, got ${miles}`);
});

test("safeDistanceAndDuration ignores an obviously-fabricated near-zero distance claim", () => {
  const pickup = { lat: 37.7479, lng: -84.2947 };
  const dest = { lat: 37.5687, lng: -84.2963 }; // ~12-13mi away in reality
  const result = safeDistanceAndDuration(pickup, dest, 0.1, 1); // claiming a fake 0.1mi, 1min trip
  assert.ok(result.distanceMiles > 10, `distance should be clamped up to reality, got ${result.distanceMiles}`);
  assert.ok(result.durationMin > 5, `duration should be clamped to something physically plausible, got ${result.durationMin}`);
});

test("safeDistanceAndDuration trusts a claim that's already reasonable or conservative", () => {
  const pickup = { lat: 37.7479, lng: -84.2947 };
  const dest = { lat: 37.5687, lng: -84.2963 };
  // Claiming MORE distance/time than the straight line (realistic — roads aren't straight)
  const result = safeDistanceAndDuration(pickup, dest, 15, 20);
  assert.equal(result.distanceMiles, 15, "an honest claim above the floor should be trusted as-is");
  assert.equal(result.durationMin, 20);
});

test("computeAuthoritativeFareCents produces a real fare even when the client sends fabricated near-zero numbers", () => {
  const pickup = { lat: 37.7479, lng: -84.2947 };
  const dest = { lat: 37.5687, lng: -84.2963 }; // ~12-13mi real trip
  const result = computeAuthoritativeFareCents({
    pickup, dest, tier: "std", roundTrip: false, waitMin: 0,
    claimedDistanceMiles: 0.01, claimedDurationMin: 0.01, // attempted tampering
  });
  // A ~12mi ride should cost well over the $8.40 minimum-fare total
  assert.ok(result.fareCents > 2000, `expected a real fare over $20, got ${result.fareCents} cents`);
});

test("round trip doubles the ride portion and can add a wait fee past the grace period, same as the frontend", () => {
  const oneWay = quoteFareCents({ distanceMiles: 5, durationMin: 12, tier: "std", roundTrip: false, waitMin: 0 });
  const roundTrip = quoteFareCents({ distanceMiles: 5, durationMin: 12, tier: "std", roundTrip: true, waitMin: 0 });
  // service fee is NOT doubled, only the ride portion is — so roundTrip != oneWay*2 exactly
  const expectedRideOnly = (oneWay - 190) * 2; // 190 cents = $1.90 service fee
  assert.equal(roundTrip - 190, expectedRideOnly);

  const withWait = quoteFareCents({ distanceMiles: 5, durationMin: 12, tier: "std", roundTrip: true, waitMin: 20 });
  assert.ok(withWait > roundTrip, "wait time past the 10-minute grace period should add to the fare");
});
