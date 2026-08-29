# Getting your backend online — step by step

You don't need to know how to code or use the command line for any of this.
It's two free websites and about 15 minutes.

## Part 1 — Put the code on GitHub (a place Render can read it from)

1. Go to **github.com** and make a free account if you don't have one.
2. Click the **+** in the top-right corner → **New repository**.
3. Name it `pullup-backend`. Leave everything else default. Click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Unzip `pullup-backend.zip` on your computer first (double-click it), then
   drag the whole unzipped **folder's contents** (not the zip itself — the
   files and folders inside it) into the browser upload box.
6. Scroll down, click **Commit changes**. Done — your code is now on GitHub.

## Part 2 — Deploy it on Render

1. Go to **render.com** and make a free account (you can sign up directly
   with your new GitHub account — easiest option).
2. Click **New** → **Blueprint**.
3. Pick the `pullup-backend` repository you just created.
4. Render will find the `render.yaml` file already in the project and set
   almost everything up for you automatically — the server, a real
   security key, and a small disk for the database. Click **Apply**.
5. Wait a few minutes while it builds. When it's done, you'll see a URL at
   the top of the page that looks like:
   `https://pullup-backend-xxxx.onrender.com`

**That URL is your real, live backend.** Send it to me and I'll connect
the app to it.

## Part 3 — Create your admin login

Render gives you a "Shell" tab on your service page — a text box connected
to your live server. Click it, and run this one line (swap in your own
name, email, and a real password):

```
npm run seed:admin -- "Your Name" you@example.com "a-strong-password"
```

That's the account you'll use to sign into the admin dashboard for real,
once it's wired up.

## One thing to know about the free tier

Render's free plan "sleeps" the server after 15 minutes of no traffic, and
takes 30–60 seconds to wake back up on the next request. Fine for testing
and a soft launch; if it feels slow once you're live with real riders, a
paid instance ($7/mo) removes that delay entirely.

## One thing to tighten before real riders use this

The blueprint leaves CORS wide open (any website can call your API) so
nothing blocks you during setup. Once you know the exact web address
your app lives at, go to your Render service → **Environment** → add
`CORS_ORIGIN` set to that address (e.g. `https://coloneltrides.netlify.app`)
and save. That locks the API down to only your app.

## What happens after you send me the URL

I'll update the app to actually call your real backend instead of
simulating everything locally — real accounts, rides that hit your real
database, live updates over your real server. Payments (Stripe) and
background checks (Checkr) are separate signups you'll do when you're
ready to take real riders; the backend already has the right shape to
plug those in when that day comes.
