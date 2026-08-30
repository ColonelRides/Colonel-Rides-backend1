const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "pullup.db");

// better-sqlite3 is synchronous — no callbacks, no promises, and it's
// fast enough for this workload. If you outgrow a single SQLite file
// (concurrent writers across multiple server instances), swap this
// module for `pg` and point every `db.prepare(...)` call at your
// Postgres pool instead. Nothing above this file needs to change.
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// `CREATE TABLE IF NOT EXISTS` only helps brand-new databases — it does
// nothing for a table that already exists with older columns, like the
// one already running on a persistent disk. This adds any columns from
// later schema versions that are missing, without touching existing data.
function ensureColumn(table, column, definition){
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if(!existing.includes(column)){
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Migrated: added ${table}.${column}`);
  }
}
ensureColumn("users", "stripe_customer_id", "TEXT");
ensureColumn("users", "stripe_payment_method_id", "TEXT");
ensureColumn("users", "card_brand", "TEXT");
ensureColumn("users", "card_last4", "TEXT");
ensureColumn("rides", "stripe_payment_intent_id", "TEXT");
ensureColumn("rides", "payment_status", "TEXT NOT NULL DEFAULT 'unpaid'");

module.exports = db;
