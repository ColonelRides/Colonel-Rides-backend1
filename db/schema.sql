-- Pull Up — core schema. SQLite dialect.
-- Money is stored in cents (INTEGER) to avoid floating-point fare bugs.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('rider','driver','admin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  payment_method  TEXT NOT NULL DEFAULT 'card' CHECK (payment_method IN ('card','cash')),
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
