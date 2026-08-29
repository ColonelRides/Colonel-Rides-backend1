const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error("JWT_SECRET is not set — copy .env.example to .env and fill it in.");
}

function signToken(user) {
  // Keep the token payload small: id + role is enough for every route
  // below to authorize correctly without a database round trip.
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token." });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not allowed for this account type." });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
