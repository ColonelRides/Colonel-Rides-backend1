// Deletes the local SQLite file so the next `npm run dev` rebuilds a
// clean schema. Never run this against a database you care about.
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "pullup.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB_PATH + suffix;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
console.log("Removed", DB_PATH, "— it will be recreated on next start.");
