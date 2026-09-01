-- Pull Up — core schema. SQLite dialect.
-- Money is stored in cents (INTEGER) to avoid floating-point fare bugs.

CREATE TABLE IF NOT EXISTS users (
  id                       TEXT PRIMARY KEY,
  role                     TEXT NOT NULL CHECK (role IN ('rider','driver','admin')),
  name                     TEXT NOT NULL,
  email                    TEXT NOT NULL UNIQUE,
  phone                    TEXT NOT NULL,
  password_hash            TEXT NOT NULL,
  stripe_customer_id       TEXT,
  stripe_payment_method_id TEXT,
  card_brand               TEXT,
  card_last4               TEXT,
  email_verified           INTEGER NOT NULL DEFAULT 0,
  email_verify_token       TEXT,
  email_verify_expires     TEXT,
  reset_token              TEXT,
  reset_token_expires      TEXT,
  referral_code            TEXT UNIQUE,
  referred_by              TEXT REFERENCES users(id),
  credit_cents             INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dob             TEXT,
  city            TEXT,
  photo_url       TEXT,
  vehicle_year    INTEGER,
  vehicle_make    TEXT,
  vehicle_model   TEXT,
  vehicle_color   TEXT,
  vehicle_plate   TEXT,
  vehicle_seats   INTEGER,
  payout_method   TEXT CHECK (payout_method IN ('bank','debit')),
  payout_last4    TEXT,
  payout_brand    TEXT,
  stripe_connect_account_id TEXT,
  stripe_connect_status     TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (stripe_connect_status IN ('not_started','pending','active')),
  ssn_last4       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rejection_note  TEXT,
  rating          REAL NOT NULL DEFAULT 5.0,
  trips_count     INTEGER NOT NULL DEFAULT 0,
  is_online       INTEGER NOT NULL DEFAULT 0,
  last_lat        REAL,
  last_lng        REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id              TEXT PRIMARY KEY,
  rider_id        TEXT NOT NULL REFERENCES users(id),
  driver_id       TEXT REFERENCES users(id),
  tier            TEXT NOT NULL CHECK (tier IN ('std','xl','now')),
  pickup_lat      REAL NOT NULL,
  pickup_lng      REAL NOT NULL,
  pickup_label    TEXT NOT NULL,
  dest_lat        REAL NOT NULL,
  dest_lng        REAL NOT NULL,
  dest_label      TEXT NOT NULL,
  distance_miles  REAL NOT NULL,
  duration_min    REAL NOT NULL,
  fare_cents      INTEGER NOT NULL,
  driver_take_cents INTEGER,
  stripe_transfer_id TEXT,
  driver_pay_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (driver_pay_status IN ('unpaid','paid','manual','failed')),
  promo_code      TEXT,
  discount_cents  INTEGER NOT NULL DEFAULT 0,
  credit_applied_cents INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'card' CHECK (payment_method IN ('card','cash')),
  stripe_payment_intent_id TEXT,
  payment_status  TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','failed','refunded')),
  tip_cents       INTEGER NOT NULL DEFAULT 0,
  stripe_tip_payment_intent_id TEXT,
  pin             TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','accepted','arriving','arrived','onTrip','complete','cancelled')),
  scheduled_for   TEXT,
  cancel_reason   TEXT,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at     TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  cancelled_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rides_rider  ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);

-- Append-only audit trail: every state change and every location tick
-- a driver reports while on a ride. Useful for support disputes later.
CREATE TABLE IF NOT EXISTS ride_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_ride ON ride_events(ride_id);

CREATE TABLE IF NOT EXISTS disputes (
  id              TEXT PRIMARY KEY,
  ride_id         TEXT NOT NULL REFERENCES rides(id),
  raised_by       TEXT NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution_note TEXT,
  refund_cents    INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

-- Web Push (VAPID) subscriptions. A user can have more than one — one
-- per browser/device they've granted notification permission on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS promo_codes (
  code           TEXT PRIMARY KEY,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value INTEGER NOT NULL, -- percent: 0-100. flat: cents.
  max_uses       INTEGER,          -- NULL = unlimited
  uses_count     INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  expires_at     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL REFERENCES promo_codes(code),
  user_id    TEXT NOT NULL REFERENCES users(id),
  ride_id    TEXT NOT NULL REFERENCES rides(id),
  discount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id, code);

-- Every credit grant or spend against a user's credit_cents balance,
-- kept as an append-only ledger so support can always reconstruct how
-- someone's balance got to where it is.
CREATE TABLE IF NOT EXISTS referral_credits (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL, -- positive = granted, negative = spent
  reason     TEXT NOT NULL,      -- 'referral_signup_bonus' | 'referral_referrer_bonus' | 'ride_credit_applied'
  ride_id    TEXT REFERENCES rides(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
