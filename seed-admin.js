// Usage: node db/seed-admin.js "Admin Name" admin@pullup.example "a-strong-password"
// Admin accounts are intentionally not creatable through POST /api/auth/signup.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("./index");

const [, , name, email, password] = process.argv;
if (!name || !email || !password) {
  console.error('Usage: node db/seed-admin.js "Name" email@example.com password');
  process.exit(1);
}

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET role='admin', password_hash=? WHERE email=?")
    .run(bcrypt.hashSync(password, 10), email.toLowerCase());
  console.log("Updated existing user to admin:", email);
} else {
  db.prepare(
    "INSERT INTO users (id, role, name, email, phone, password_hash) VALUES (?, 'admin', ?, ?, ?, ?)"
  ).run(uuid(), name, email.toLowerCase(), "", bcrypt.hashSync(password, 10));
  console.log("Created admin user:", email);
}
