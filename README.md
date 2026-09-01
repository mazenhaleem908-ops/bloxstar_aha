# BloxStar

Standalone storefront for Roblox items, pets and bundles.

- **Frontend**: the complete storefront (`public/storefront.html`) — all pages, 341 products, cart, login/OTP UI, orders, admin panel and MoonPay checkout — served at `/`.
- **Framework**: TanStack Start (React 19 + Vite 8), built for **Vercel**.
- **Database**: **Neon PostgreSQL** (serverless HTTP driver).
- **Email / OTP**: **Resend**.
- **Payments**: **MoonPay** hosted card checkout (publishable key configured in the storefront).

No Lovable or Supabase runtime dependency remains.

## 1. Install

```bash
npm install      # or: bun install / pnpm install
```

## 2. Database (Neon)

Create a Neon project, then apply the schema once:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

This creates `auth_codes`, `auth_sessions`, `orders`, `item_stock` and the
`reserve_stock` / `release_stock` functions used for atomic stock reservation.

## 3. Environment variables

Copy `.env.example` to `.env` (local) and add the same variables in
Vercel → Project → Settings → Environment Variables.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL connection string (pooled, `sslmode=require`) |
| `RESEND_API_KEY` | Resend API key for OTP + transactional email |
| `RESEND_FROM_EMAIL` | Sender address (default `business@bloxistar.com`) |
| `RESEND_FROM_NAME` | Sender display name (default `BloxStar`) |
| `ADMIN_EMAILS` | Comma-separated admin emails that receive the admin session flag |

## 4. Develop

```bash
npm run dev      # http://localhost:8080
```

## 5. Build

```bash
npm run build    # produces .vercel/output (Vercel Build Output API v3)
npm run preview
```

## 6. Deploy to Vercel

Import the repository in Vercel and deploy — the build emits `.vercel/output`
directly, so no framework preset is needed. Set the environment variables above
before the first deploy.

## API

All endpoints live under `/api/public` and are same-origin with the storefront.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/public/auth/send-code` | POST | Emails a 6-digit OTP (1/min per email) |
| `/api/public/auth/verify-code` | POST | Verifies the OTP, returns a 30-day session token |
| `/api/public/auth/session` | POST | Validates a session token |
| `/api/public/email/send` | POST | Sends transactional email via Resend |
| `/api/public/orders` | GET/POST/PATCH | Create, list, confirm and cancel orders |

Pricing, the 4.5% / $3.99-minimum card fee, stock reservation and all
status transitions are enforced server-side; client-supplied prices are ignored.

## Project layout

```
db/schema.sql                Neon schema + stock functions
public/storefront.html       the complete storefront application
src/lib/db.ts                Neon connection helper
src/lib/catalog.ts           server-side product catalogue (source of truth for prices)
src/routes/index.tsx         serves the storefront at /
src/routes/api/public/*      backend endpoints
```
