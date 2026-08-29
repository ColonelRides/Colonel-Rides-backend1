# Pull Up — backend

A real Express + Socket.io + SQLite API: accounts, driver onboarding,
ride dispatch, live location, and the admin endpoints the dashboard
needs. This is the piece the rest of the app was missing — everything
in `pullup.html` up to now has been simulated in one browser tab.

**I wrote and syntax-checked every file here, but I have not run it
end-to-end** — this sandbox has no outbound network access, so `npm
install` can't reach the npm registry from inside it. Treat this as a
reviewed starter, not a tested one, and run it locally before you
trust it with real signups.

## Run it locally

```bash
cd pullup-backend
npm install
cp .env.example .env        # then edit JWT_SECRET at minimum
npm run dev
```

Server comes up on `http://localhost:4000`. `GET /health` should
return `{"ok":true}`. A `pullup.db` SQLite file is created next to
`db/schema.sql` on first run — delete it (or run `npm run db:reset`)
any time you want a clean slate.

Create an admin account (not possible through public signup, on purpose):

```bash
npm run seed:admin -- "Your Name" you@pullup.example "a-strong-password"
```

## What's real here vs. what's a placeholder

| Real | Placeholder — swap before launch |
|---|---|
| Password hashing (bcrypt), JWTs, role checks | Driver background check — currently a `setTimeout` auto-approve. Wire Checkr's webhook to `PATCH /api/admin/drivers/:id/approve` instead |
| Ride state machine with enforced legal transitions | Card payments — client sends a `fareCents` number, nothing actually touches Stripe. Wire Stripe Connect and only accept the fare it confirms |
| Pickup PIN checked server-side before a trip can start | Fare pricing — the server trusts the number the client sends. Recompute it server-side from distance/duration before launch, or a client can submit any fare it wants |
| Live location + ride status over Socket.io | Push notifications — nothing here sends one. The frontend has to be open and connected to get updates |

## Deploying

Any Node host works (Render, Railway, Fly.io, a $5 VPS). Three things
to get right:

1. **Persistent disk for `DB_PATH`.** SQLite is a single file — if your
   host wipes the filesystem on redeploy (some free tiers do), point
   `DB_PATH` at a mounted volume, or migrate to Postgres once you have
   real traffic (see below).
2. **Set `JWT_SECRET` and `CORS_ORIGIN`** in the host's environment
   variables, not in a committed `.env`.
3. **HTTPS.** The frontend's GPS features require it, and Socket.io
   should run over `wss://`, which you get for free on every platform
   listed above.

### Outgrowing SQLite

`db/index.js` is the only file that knows SQLite exists. Every route
calls `db.prepare(...).run(...)/.get(...)/.all(...)`, which is also
roughly how `pg` (Postgres) or `pg-promise` read. When you need
multiple server instances behind a load balancer — SQLite can't do
concurrent writers across processes — swap that one file for a
Postgres pool and keep the query shapes as close as you can.

## Mapping the frontend onto this API

`pullup.html` has a `Dispatch` object that currently simulates
everything in-memory. Its methods map onto this API almost exactly —
this was deliberate, going back to when Dispatch was first built:

| `Dispatch` method (frontend) | Backend call |
|---|---|
| `Dispatch.request(ride)` | `POST /api/rides` with `{pickup, dest, tier, distanceMiles, durationMin, fareCents, paymentMethod}` |
| `Dispatch.accept(driver)` | `POST /api/rides/:id/accept` |
| driver taps "Start trip" (PIN check) | `PATCH /api/rides/:id/status` with `{status:"onTrip", pin}` |
| `Dispatch.startTrip()` | `PATCH /api/rides/:id/status` with `{status:"complete"}` when the trip ends |
| `Dispatch.cancel()` | `PATCH /api/rides/:id/status` with `{status:"cancelled"}` |
| live driver dot on the rider's map | socket `driver:location` emitted by the driver, `ride:driverLocation` received by the rider |
| driver onboarding wizard submit | `POST /api/drivers/apply` |
| "Edit profile" save | `PATCH /api/drivers/me` |
| going online/offline | `POST /api/drivers/online` (REST, for persistence) **and** socket `driver:online` (for the live broadcast room) |

None of the UI in `pullup.html` needs to change shape to use this —
only the `Dispatch` object's method bodies do, replacing the
`setTimeout`/local-state simulation with `fetch()` and a
`socket.io-client` connection authenticated with the JWT from login.

## Auth flow

1. `POST /api/auth/signup` `{name, email, phone, password, role}` → `{token, user}`
2. `POST /api/auth/login` `{email, password}` → `{token, user}`
3. Send `Authorization: Bearer <token>` on every other request.
4. Connect the socket with `io(url, { auth: { token } })`.

## Full endpoint list

```
POST   /api/auth/signup
POST   /api/auth/login
GET    /api/auth/me

POST   /api/drivers/apply           (driver)  — first onboarding submission
GET    /api/drivers/me              (driver)
PATCH  /api/drivers/me              (driver)  — edit after approval
POST   /api/drivers/online          (driver)  — {online, lat, lng}

POST   /api/rides                   (rider)   — request a ride
GET    /api/rides/mine
GET    /api/rides/:id
POST   /api/rides/:id/accept        (driver)
PATCH  /api/rides/:id/status        — {status, pin?, reason?}
POST   /api/rides/:id/dispute       — {reason}

GET    /api/admin/stats             (admin)
GET    /api/admin/drivers/pending   (admin)
GET    /api/admin/drivers           (admin)
PATCH  /api/admin/drivers/:userId/approve   (admin)
PATCH  /api/admin/drivers/:userId/reject    (admin) — {reason}
GET    /api/admin/rides/live        (admin)
GET    /api/admin/rides             (admin)
GET    /api/admin/disputes          (admin) — ?status=open|resolved
PATCH  /api/admin/disputes/:id/resolve (admin) — {note, refundCents}
```
