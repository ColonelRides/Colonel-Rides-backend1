const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { stripe } = require("./payments");

const router = express.Router();

function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({ error: "Payments aren't configured on this server yet." });
  next();
}

// Kicks off (or resumes) Stripe Express onboarding for a driver. Express
// accounts push all the identity/bank-account collection onto Stripe's
// own hosted flow — the driver never types a routing number into our
// server, and we never have to store or validate one ourselves.
//
// `returnUrl`/`refreshUrl` should be pages in the deployed frontend (e.g.
// the driver profile screen) — Stripe redirects the driver's browser back
// there when onboarding finishes or needs to be resumed.
router.post("/onboard", requireAuth, requireRole("driver"), requireStripe, async (req, res) => {
  const { returnUrl, refreshUrl } = req.body || {};
  if (!returnUrl || !refreshUrl) {
    return res.status(400).json({ error: "returnUrl and refreshUrl are both required." });
  }

  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    const profile = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
    if (!profile) return res.status(404).json({ error: "Complete your driver application first." });

    let accountId = profile.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email,
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        metadata: { app_user_id: user.id },
      });
      accountId = account.id;
      db.prepare(
        "UPDATE driver_profiles SET stripe_connect_account_id=?, stripe_connect_status='pending', updated_at=datetime('now') WHERE user_id=?"
      ).run(accountId, req.user.id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (e) {
    console.error("connect/onboard error:", e.message);
    res.status(500).json({ error: "Couldn't start Stripe onboarding." });
  }
});

// Called after the driver lands back from Stripe (or any time the
// frontend wants to refresh what it's showing) — this is the one place
// that actually asks Stripe whether the account can receive transfers
// yet, rather than trusting anything the client says.
router.get("/status", requireAuth, requireRole("driver"), requireStripe, async (req, res) => {
  const profile = db.prepare("SELECT * FROM driver_profiles WHERE user_id = ?").get(req.user.id);
  if (!profile || !profile.stripe_connect_account_id) {
    return res.json({ status: "not_started", payoutsEnabled: false });
  }

  try {
    const account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
    const status = account.payouts_enabled ? "active" : "pending";
    db.prepare(
      "UPDATE driver_profiles SET stripe_connect_status=?, updated_at=datetime('now') WHERE user_id=?"
    ).run(status, req.user.id);
    res.json({
      status,
      payoutsEnabled: !!account.payouts_enabled,
      detailsSubmitted: !!account.details_submitted,
      requirementsDue: (account.requirements && account.requirements.currently_due) || [],
    });
  } catch (e) {
    console.error("connect/status error:", e.message);
    res.status(500).json({ error: "Couldn't check Stripe account status." });
  }
});

module.exports = router;
        
