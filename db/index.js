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

module.exports = db;
