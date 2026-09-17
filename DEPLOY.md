# Deployment Guide — Supabase + Render

Quick reference for deploying this backend against a Supabase Postgres
database, hosted on Render. Pairs with `marchesdirect-frontend` deployed on
Vercel.

## 1. Supabase (database)

1. Open your Supabase project → **Settings → Database → Connection string**.
2. Copy the **Session pooler** URI (port `6543`, starts with `postgres://`).
   This is your `DATABASE_URL`.
3. Nothing else to do manually — on first boot this backend auto-detects an
   empty database and loads `schema.sql` itself (see `ensureSchema()` in
   `src/config/database.ts`). No need to run `psql` by hand.

## 2. Render (backend API)

1. **New → Web Service**, connect the `marchesdirect-backend` GitHub repo.
2. Build command: `npm install` (the `postinstall` script runs `tsc` for you).
3. Start command: `npm start`.
4. Add environment variables (Render → your service → **Environment**):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase session-pooler string from step 1 |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | random string, e.g. `openssl rand -hex 32` |
   | `REFRESH_TOKEN_SECRET` | a *different* random string |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `FRONTEND_URL` | your deployed Vercel URL, e.g. `https://marchesdirect.vercel.app` |

   `PORT` is set automatically by Render — don't override it.

   Everything else in `.env.example` (AWS S3, Stripe, BOAMP/PLACE, SMTP,
   Redis) is optional: the server boots fine without them, only the specific
   feature that depends on a given key will error until it's set.

5. Deploy, then sanity-check `https://<your-service>.onrender.com/health`
   returns `{"status":"ok"}`.

## 3. Vercel (frontend)

1. Import `MarchesDirect` (github.com/syntralogic/MarchesDirect - the Vite/React
   frontend actually in use; `marchesdirect-frontend`, an earlier Next.js
   attempt, is no longer the live frontend) as a new Vercel project (Vite
   auto-detected).
2. Add one environment variable, for both Production and Preview:

   | Variable | Value |
   | --- | --- |
   | `VITE_API_URL` | your Render backend URL, no trailing slash |

3. Deploy.

## 4. Verify end-to-end

- Open a listing page (e.g. `/marches-publics`) — you should see real data,
  not the mock fallback.
- Try registering/logging in. `"Impossible de contacter le serveur"` means
  `VITE_API_URL` is wrong; a CORS error in the browser console means
  `FRONTEND_URL` on Render doesn't match the actual Vercel URL.

## Troubleshooting

- **DB connection fails on Render**: double-check you copied the *pooler*
  connection string (not the direct connection) — Supabase's pooler is what
  works reliably from Render's network.
- **CORS errors**: `FRONTEND_URL` on Render must exactly match the frontend's
  live URL (including `https://`, no trailing slash).
- **Stripe webhook 400s**: `STRIPE_WEBHOOK_SECRET` must match the endpoint
  you register in the Stripe dashboard, not the one from local `stripe listen`.
