const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const push = require("../lib/push");

const router = express.Router();

// Public — the frontend needs this to call pushManager.subscribe(), before
// the user is necessarily logged in on this device yet.
router.get("/vapid-public-key", (req, res) => {
  const key = push.publicKey();
  if (!key) return res.status(503).json({ error: "Push notifications aren't configured on this server yet." });
  res.json({ publicKey: key });
});

router.post("/subscribe", requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  const endpoint = subscription && subscription.endpoint;
  const keys = subscription && subscription.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: "A valid PushSubscription object is required." });
  }

  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
     VALUES (@id, @user_id, @endpoint, @p256dh, @auth)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`
  ).run({ id: uuid(), user_id: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth });

  res.status(201).json({ ok: true });
});

router.post("/unsubscribe", requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint is required." });
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
