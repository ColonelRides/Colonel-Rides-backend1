// A minimal in-memory rate limiter — no new dependency to install, which
// matters here since this environment can't verify an npm package
// actually works before shipping it. Good enough for a single-instance
// deployment; if this ever runs across multiple server instances behind
// a load balancer, the count should move to something shared (Redis) —
// each instance would otherwise track its own separate count.
//
// Tracks attempts per key (IP + route) in a fixed window. Cleans up
// expired entries lazily so memory doesn't grow unbounded.

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const key = (req.ip || req.socket.remoteAddress || "unknown") + ":" + req.baseUrl + req.path;
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: message || "Too many attempts. Try again in a few minutes." });
    }

    // Lazy cleanup: occasionally sweep expired entries so the map doesn't
    // grow forever under sustained traffic. Cheap enough to do inline —
    // this isn't a hot path compared to the bcrypt hashing login already does.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }

    next();
  };
}

module.exports = { createRateLimiter };
