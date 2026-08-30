const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

if(!process.env.STRIPE_SECRET_KEY){
  console.warn("STRIPE_SECRET_KEY is not set — payment routes will return errors until it's added.");
}
// Pinning an explicit API version, per Stripe's own recommendation, so a
// future account-level default change can't silently alter behavior here.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" })
  : null;

function requireStripe(req, res, next){
  if(!stripe) return res.status(503).json({ error: "Payments aren't configured on this server yet." });
  next();
}

// Step 1: get a SetupIntent so the rider's browser can securely save a
// card via Stripe Elements. Creates their Stripe Customer on first use.
router.post("/setup-intent", requireAuth, requireRole("rider"), requireStripe, async (req, res) => {
  try{
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    let customerId = user.stripe_customer_id;

    if(!customerId){
      const customer = await stripe.customers.create({
        name: user.name,
        email: user.email,
        phone: user.phone,
        metadata: { app_user_id: user.id },
      });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
    });

    res.json({ clientSecret: setupIntent.client_secret, publishableAccount: customerId });
  }catch(e){
    console.error("setup-intent error:", e.message);
    res.status(500).json({ error: "Couldn't start card setup with Stripe." });
  }
});

// Step 2: after Stripe.js confirms the SetupIntent client-side, the
// frontend sends back the resulting PaymentMethod id so we can save it
// (and store card brand/la
