req.user.id) });
});


// Tips are their own charge — a separate PaymentIntent, added after the
// ride's own fare is already settled, using the same saved card.
router.post("/:id/tip", requireAuth, requireRole("rider"), async (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  if (row.rider_id !== req.user.id) return res.status(403).json({ error: "Not your ride." });
  if (row.status !== "complete") return res.status(409).json({ error: "Can only tip a completed ride." });
  if (row.tip_cents) return res.status(409).json({ error: "This ride already has a tip." });

  const { tipCents } = req.body || {};
  const amount = Math.round(Number(tipCents));
  if (!amount || amount < 50) return res.status(400).json({ error: "Tip must be at least $0.50." });

  if (row.payment_method === "cash") {
    // no card on file for this ride — just record the intent to tip in cash
    db.prepare("UPDATE rides SET tip_cents=? WHERE id=?").run(amount, row.id);
    logEvent(row.id, "tip:cash", { amount });
    return res.json({ ok: true, tipCents: amount, charged: false });
  }

  if (!stripe) return res.status(503).json({ error: "Payments aren't configured on this server yet." });
  const rider = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!rider.stripe_customer_id || !rider.stripe_payment_method_id) {
    return res.status(400).json({ error: "No card on file to charge the tip to." });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      customer: rider.stripe_customer_id,
      payment_method: rider.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: { ride_id: row.id, kind: "tip" },
    });
    db.prepare("UPDATE rides SET tip_cents=?, stripe_tip_payment_intent_id=? WHERE id=?")
      .run(amount, intent.id, row.id);
    logEvent(row.id, "tip:charged", { amount, stripePaymentIntentId: intent.id });
    res.json({ ok: true, tipCents: amount, charged: true });
  } catch (e) {
    console.warn("Tip charge failed for ride", row.id, ":", e.message);
    res.status(402).json({ error: "Couldn't charge the tip: " + e.message });
  }
});

router.post("/:id/dispute", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM rides WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ride not found." });
  const isParticipant = row.rider_id === req.user.id || row.driver_id === req.user.id;
  if (!isParticipant) return res.status(403).json({ error: "Not your ride." });

  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: "reason is required." });

  const id = uuid();
  db.prepare("INSERT INTO disputes (id, ride_id, raised_by, reason) VALUES (?, ?, ?, ?)")
    .run(id, row.id, req.user.id, reason);
  res.status(201).json({ disputeId: id });
});

module.exports = router;
