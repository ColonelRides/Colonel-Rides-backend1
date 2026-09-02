const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendMail } = require("../lib/mailer");
const { createRateLimiter } = require("../lib/rateLimit");

const router = express.Router();

// Generous enough that a real person mistyping a password a few times
// never notices, tight enough that scripting thousands of guesses
// against one account (or spraying one password across many emails)
// actually gets slowed down.
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many login attempts. Try again in a few minutes." });
const signupLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 8, message: "Too many accounts created from this connection. Try again later." });
const forgotLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, message: "Too many reset requests. Try again later." });
const resetLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many attempts. Try again in a few minutes." });

const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
if (!FRONTEND_URL) {
  console.warn(
    "auth: FRONTEND_URL is not set — verification and password-reset emails " +
    "will contain a relative link instead of a full one. Set it to your " +
    "deployed frontend's URL (e.g. https://your-app.netlify.app)."
  );
}

function publicUser(row) {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role,
    emailVerified: !!row.email_verified,
    referralCode: row.referral_code,
    creditCents: row.credit_cents || 0,
  };
}

// Short, unread-aloud-friendly codes: uppercase letters + digits, with
// visually ambiguous characters (0/O, 1/I/L) removed.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateReferralCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const exists = db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(code);
    if (!exists) return code;
  }
  // Astronomically unlikely, but fall back to something guaranteed-unique.
  return uuid().slice(0, 8).toUpperCase();
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

router.post("/signup", signupLimiter, (req, res) => {
  const { name, email, phone, password, role, referralCode } = req.body || {};
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

  let referredBy = null;
  if (referralCode) {
    const referrer = db.prepare("SELECT id FROM users WHERE referral_code = ?").get(String(referralCode).toUpperCase().trim());
    if (referrer) referredBy = referrer.id;
    // An unrecognized code is silently ignored rather than blocking signup —
    // a typo in a referral code shouldn't stop someone from creating an account.
  }

  const verifyToken = randomToken();
  const row = {
    id: uuid(),
    role,
    name: String(name).trim(),
    email: email.toLowerCase().trim(),
    phone: String(phone).trim(),
    password_hash: bcrypt.hashSync(password, 10),
    referral_code: generateReferralCode(),
    referred_by: referredBy,
    email_verify_token: verifyToken,
    email_verify_expires: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
  db.prepare(
    `INSERT INTO users (id, role, name, email, phone, password_hash, referral_code, referred_by, email_verify_token, email_verify_expires)
     VALUES (@id, @role, @name, @email, @phone, @password_hash, @referral_code, @referred_by, @email_verify_token, @email_verify_expires)`
  ).run(row);

  const verifyLink = `${FRONTEND_URL}/?verifyToken=${verifyToken}`;
  sendMail({
    to: row.email,
    subject: "Verify your ZIPP account",
    text: `Hi ${row.name},\n\nConfirm your email to finish setting up your ZIPP account:\n${verifyLink}\n\nThis link expires in 24 hours.`,
  }).catch(() => {}); // best-effort — signup should never fail because of a mail hiccup

  res.status(201).json({ token: signToken(row), user: publicUser(row) });
});

router.post("/login", loginLimiter, (req, res) => {
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

// ---------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------

// Re-sends the verification link — used if the first email never arrived
// or the 24-hour link expired.
router.post("/verify/request", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!row) return res.status(404).json({ error: "User not found." });
  if (row.email_verified) return res.json({ ok: true, alreadyVerified: true });

  const token = randomToken();
  db.prepare(
    "UPDATE users SET email_verify_token=?, email_verify_expires=? WHERE id=?"
  ).run(token, new Date(Date.now() + 24 * 3600 * 1000).toISOString(), row.id);

  const verifyLink = `${FRONTEND_URL}/?verifyToken=${token}`;
  sendMail({
    to: row.email,
    subject: "Verify your ZIPP account",
    text: `Hi ${row.name},\n\nConfirm your email:\n${verifyLink}\n\nThis link expires in 24 hours.`,
  }).catch(() => {});

  res.json({ ok: true });
});

// Not behind requireAuth on purpose — the token in the link IS the
// credential. This lets the frontend confirm a verification link even if
// the person clicked it from a different browser/device than they signed
// up on.
router.post("/verify/confirm", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required." });

  const row = db.prepare("SELECT * FROM users WHERE email_verify_token = ?").get(token);
  if (!row) return res.status(400).json({ error: "That verification link is invalid or already used." });
  if (new Date(row.email_verify_expires) < new Date()) {
    return res.status(400).json({ error: "That verification link has expired. Request a new one." });
  }

  db.prepare(
    "UPDATE users SET email_verified=1, email_verify_token=NULL, email_verify_expires=NULL WHERE id=?"
  ).run(row.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------

// Always responds 200 regardless of whether the email is on file — this
// is standard practice so the endpoint can't be used to check which
// emails have an account.
router.post("/password/forgot", forgotLimiter, (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email is required." });

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
  if (row) {
    const token = randomToken();
    db.prepare(
      "UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?"
    ).run(token, new Date(Date.now() + 3600 * 1000).toISOString(), row.id);

    const resetLink = `${FRONTEND_URL}/?resetToken=${token}`;
    sendMail({
      to: row.email,
      subject: "Reset your ZIPP password",
      text: `Hi ${row.name},\n\nReset your password:\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    }).catch(() => {});
  }

  res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
});

router.post("/password/reset", resetLimiter, (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword are required." });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const row = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
  if (!row) return res.status(400).json({ error: "That reset link is invalid or already used." });
  if (new Date(row.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: "That reset link has expired. Request a new one." });
  }

  db.prepare(
    "UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?"
  ).run(bcrypt.hashSync(newPassword, 10), row.id);

  res.json({ ok: true });
});

module.exports = router;
  
