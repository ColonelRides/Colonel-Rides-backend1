const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

if(!process.env.STRIPE_SECRET_KEY){
  console.warn("STRIPE_SECRET_KEY is not set.");
}
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-06-24.dahlia" })
  : null;

function requireStripe(req, res, next){
  if(!stripe) return res.status(503).json({ error: "Payments aren't configured yet." });
  next();
}

router.post("/setup-intent", requireAuth, requireRole("rider"), requireStripe, async (req, res) => {
  try{
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    let customerId = user.stripe_customer_id;
    if(!customerId){
      const customer = await stripe.customers.create({
        name: user.name, email: user.email, phone: user.phone,
        metadata: { app_user_id: user.id },
      });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
    }
    const setupIntent = await stripe.setupIntents.create({ customer: customerId, usage: "off_session" });
    res.json({ clientSecret: setupIntent.client_secret });
  }catch(e){
    console.error("setup-intent error:", e.message);
    res.status(500).json({ error: "Couldn't start card setup with Stripe." });
  }
});

router.post("/save-method", requireAuth, requireRole("rider"), requireStripe, async (req, res) => {
  const { paymentMethodId } = req.body || {};
  if(!paymentMethodId) return res.status(400).json({ error: "paymentMethodId is required." });
  try{
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if(!pm.card) return res.status(400).json({ error: "That payment method isn't a card." });
    db.prepare(
      "UPDATE users SET stripe_payment_method_id = ?, card_brand = ?, card_last4 = ? WHERE id = ?"
    ).run(paymentMethodId, pm.card.brand, pm.card.last4, req.user.id);
    res.json({ ok: true, brand: pm.card.brand, last4: pm.card.last4 });
  }catch(e){
    console.error("save-method error:", e.message);
    res.status(500).json({ error: "Couldn't save that card." });
  }
});

router.get("/method", requireAuth, requireRole("rider"), (req, res) => {
  const user = db.prepare("SELECT card_brand, card_last4 FROM users WHERE id = ?").get(req.user.id);
  res.json({ hasCard: !!user.card_last4, brand: user.card_brand, last4: user.card_last4 });
});

module.exports = { router, stripe };
