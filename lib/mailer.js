const nodemailer = require("nodemailer");

// Generic SMTP transport — works with SendGrid, Postmark, AWS SES, Gmail,
// or literally any provider that hands out SMTP credentials, so switching
// providers later never means touching this file.
//
// Required env vars for real delivery:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
// If any of those are missing, this falls back to logging the email to
// the console instead of sending it — so signup/reset/verify flows keep
// working end-to-end in dev, and nothing throws just because no mail
// credentials have been configured yet.
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn(
    "Mailer: SMTP_HOST/SMTP_USER/SMTP_PASS not set — verification and " +
    "password-reset emails will be logged to the console instead of sent. " +
    "Add real SMTP credentials before launch."
  );
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || "ZIPP <no-reply@zipp.example>";
  if (!transporter) {
    console.log(`\n[mailer:fallback] Would send email:\n  To: ${to}\n  From: ${from}\n  Subject: ${subject}\n  Body:\n${text}\n`);
    return { delivered: false, fallback: true };
  }
  try {
    await transporter.sendMail({ from, to, subject, text, html: html || undefined });
    return { delivered: true, fallback: false };
  } catch (e) {
    console.error("Mailer: send failed —", e.message);
    // Never let a mail failure break the request that triggered it
    // (signup, reset request, etc.) — the caller treats this as best-effort.
    return { delivered: false, fallback: false, error: e.message };
  }
}

module.exports = { sendMail };
