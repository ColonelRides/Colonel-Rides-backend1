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
ensureColumn("rides", "tip_cents", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("rides", "stripe_tip_payment_intent_id", "TEXT");

// SQLite can't ALTER a CHECK constraint directly — allowing a new status
// value ('refunded') requires recreating the table. This only runs if
// the existing table doesn't already allow it, and copies every row
// across untouched before dropping the old table.
function ensureRidesAllowsRefunded(){
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rides'").get();
  if (!tableSql || tableSql.sql.includes("'refunded'")) return;   // already allows it, or table is brand new anyway

  console.log("Migrating rides table to allow payment_status='refunded'...");
  db.exec("ALTER TABLE rides RENAME TO rides_old_precheck");
  db.exec(schema);   // recreates `rides` with the current, correct constraint (and re-adds any missing tables, harmlessly, via IF NOT EXISTS)
  const oldCols = db.prepare("PRAGMA table_info(rides_old_precheck)").all().map(c => c.name);
  const newCols = db.prepare("PRAGMA table_info(rides)").all().map(c => c.name);
  const common = oldCols.filter(c => newCols.includes(c));
  db.exec(`INSERT INTO rides (${common.join(",")}) SELECT ${common.join(",")} FROM rides_old_precheck`);
  db.exec("DROP TABLE rides_old_precheck");
  console.log("Migration complete — all existing rides preserved.");
}
ensureRidesAllowsRefunded();

module.exports = db;
