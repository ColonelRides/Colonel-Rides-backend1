const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role };
}

router.post("/signup", (req, res) => {
  const { name, email, phone, password, role } = req.body || {};
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: "name, email, phone, and password are all required." });
  }
  if (!["rider", "driver"].includes(role)) {
    return res.status(400).json({ error: "role must be 'rider' or 'driver'." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "An account with that email already exists." });

  const row = {
    id: uuid(),
    role,
    name: String(name).trim(),
    email: email.toLowerCase().trim(),
    phone: String(phone).trim(),
    password_hash: bcrypt.hashSync(password, 10),
  };
  db.prepare(
    "INSERT INTO users (id, role, name, email, phone, password_hash) VALUES (@id, @role, @name, @email, @phone, @password_hash)"
  ).run(row);

  res.status(201).json({ token: signToken(row), user: publicUser(row) });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required." });

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  res.json({ token: signToken(row), user: publicUser(row) });
});

router.get("/me", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!row) return res.status(404).json({ error: "User not found." });
  res.json({ user: publicUser(row) });
});

module.exports = router;
