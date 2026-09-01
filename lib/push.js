const webpush = require("web-push");
const db = require("../db");

// VAPID keys identify this server to push services (Chrome/Firefox/etc.)
// Generate a pair once with `npx web-push generate-vapid-keys` and set
// them as env vars — the same public key also needs to be dropped into
// CFG.push.vapidPublicKey in the frontend so the two sides match.
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@zipp.example";

let enabled = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  enabled = true;
} else {
  console.warn(
    "Push: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications " +
    "are disabled. Real-time in-app updates (Socket.IO) still work as normal; " +
    "this only affects notifications while the app is closed or backgrounded."
  );
}

function publicKey() {
  return enabled ? PUBLIC_KEY : null;
}

// Fire-and-forget by design: push is a convenience channel for when the
// app isn't in the foreground. A failed push should never fail the ride
// action (accept, arrive, complete, etc.) that triggered it.
async function sendToUser(userId, payload) {
  if (!enabled) return;
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
  const body = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (e) {
      // 404/410 = the browser/OS has permanently invalidated this
      // subscription (uninstalled, permission revoked, etc.) — clean it
      // up so we stop wasting sends on it. Anything else, just log it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
      } else {
        console.warn("Push: send failed for subscription", sub.id, "—", e.message);
      }
    }
  }));
}

async function sendToUsers(userIds, payload) {
  await Promise.all(userIds.map((id) => sendToUser(id, payload)));
}

module.exports = { enabled: () => enabled, publicKey, sendToUser, sendToUsers };
