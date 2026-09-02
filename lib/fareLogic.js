// Server-side fare authority. Mirrors the frontend's quoteFare() exactly
// (same constants, same formula) so displayed and charged amounts match
// under normal use — but unlike the frontend, this is the version that
// actually decides what gets charged. The client's own numbers
// (distanceMiles, durationMin, fareCents) are never trusted directly:
// this recomputes distance from the pickup/dest coordinates themselves
// and clamps duration to what's physically plausible, so a modified
// client claiming "0.1 miles" for a real 20-mile trip can't talk the
// server into charging for 0.1 miles.
//
// Kept dependency-free (no express, no db) so it's directly unit-testable
// — see test/fare-server.test.js.

const FARE = { base: 2.75, perMile: 1.35, perMin: 0.32, minimum: 6.5, service: 1.90, waitGraceMin: 10, waitPerMin: 0.40 };
const TIER_MULT = { std: 1.00, xl: 1.55, now: 1.25 };

// Straight-line distance between two coordinates, in miles. This is a
// floor, not an estimate — real road distance is always >= this, so
// clamping a claimed distance up to this value (never down) can only
// ever correct an under-statement, never penalize an honest long detour.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth's radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// No real road anywhere supports much over ~80mph sustained, so a claimed
// duration shorter than "distance at 80mph" is physically impossible —
// clamp it up rather than trust it. This only ever raises an
// implausibly-short duration; it never lowers a genuinely slow trip.
const MAX_PLAUSIBLE_MPH = 80;

function safeDistanceAndDuration(pickup, dest, claimedDistanceMiles, claimedDurationMin) {
  const straightLineMiles = haversineMiles(pickup.lat, pickup.lng, dest.lat, dest.lng);
  const distanceMiles = Math.max(Number(claimedDistanceMiles) || 0, straightLineMiles);
  const minPlausibleDurationMin = (distanceMiles / MAX_PLAUSIBLE_MPH) * 60;
  const durationMin = Math.max(Number(claimedDurationMin) || 0, minPlausibleDurationMin);
  return { distanceMiles, durationMin };
}

// The exact formula from the frontend's quoteFare(), operating on
// already-validated distance/duration instead of raw meters/seconds.
function quoteFareCents({ distanceMiles, durationMin, tier, roundTrip, waitMin }) {
  const mult = TIER_MULT[tier];
  if (!mult) throw new Error(`Unknown tier: ${tier}`);
  const legs = roundTrip ? 2 : 1;
  const ride = (FARE.base + distanceMiles * FARE.perMile + durationMin * FARE.perMin) * mult * legs;
  const billableWait = roundTrip ? Math.max(0, (waitMin || 0) - FARE.waitGraceMin) : 0;
  const waitFeeCents = Math.round(billableWait * FARE.waitPerMin * 100);
  const rideCents = Math.round(Math.max(ride, FARE.minimum) * 100) + waitFeeCents;
  return rideCents + Math.round(FARE.service * 100);
}

// Puts both steps together: validate the claimed trip numbers against
// physical reality, then compute the authoritative fare from the
// validated numbers. This is what ride creation actually calls.
function computeAuthoritativeFareCents({ pickup, dest, tier, roundTrip, waitMin, claimedDistanceMiles, claimedDurationMin }) {
  const { distanceMiles, durationMin } = safeDistanceAndDuration(pickup, dest, claimedDistanceMiles, claimedDurationMin);
  const fareCents = quoteFareCents({ distanceMiles, durationMin, tier, roundTrip, waitMin });
  return { fareCents, distanceMiles, durationMin };
}

module.exports = { haversineMiles, safeDistanceAndDuration, quoteFareCents, computeAuthoritativeFareCents, FARE, TIER_MULT };
