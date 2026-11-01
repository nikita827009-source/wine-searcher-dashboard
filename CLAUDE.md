# Fine Liquors Competitor Pricing Dashboard

Express 5 + Prisma (SQLite) backend serving `winesearcher/fine.html`.
Root: `D:\wine` — server lives at `winesearcher/wine-scraper/`.

## Quick start

```
cd winesearcher/wine-scraper
cp .env.example .env          # set ADMIN_TOKEN
npm install
npx prisma migrate deploy
npm run import                # import wine_dataset.json (idempotent)
npm start                     # http://localhost:5000
```

Admin token is required for `POST /api/refresh` and `POST /api/import`. Set it in `.env` as `ADMIN_TOKEN`.

## Architecture

```
fine.html  ←→  Express 5 (src/app.js)
                  ├─ Prisma (SQLite dev.db)        src/lib/db.js
                  ├─ Provider registry             src/providers/index.js
                  │     mock                       src/providers/mock.js
                  │     winesearcher-api (stub)    src/providers/winesearcherApi.js
                  ├─ Refresh job runner            src/jobs/refresh.js
                  ├─ Dataset importer              src/import/importer.js + cli.js
                  └─ Pricing utils                 src/pricing/compare.js
```

## Provider system

Active provider is set by `PROVIDER=<name>` in `.env`. All providers implement:

```js
{
  name: string,
  verifies: boolean,          // true → results stored as VERIFIED; false → DEMO
  fetchTimeoutMs?: number,    // optional override for the refresh runner's timeout
  meta(): { name, description, sourceType, refreshFrequency, requires[] },
  status(): { configured: boolean, state: string, reason: string|null },
  async fetchOffers(products): Observation[],
}
```

`fetchOffers` input: `[{ sourceKey, clientPrice, offers: [{ vendorName }] }]`
`fetchOffers` output: `[{ productKey, vendorName, price, currency, url, availability, observedAt }]`

### winesearcher-api (stub)

Requires a licensed API key from Wine-Searcher. Set `WINESEARCHER_API_KEY` and `PROVIDER=winesearcher-api`. The adapter (`src/providers/winesearcherApi.js`) reports `NOT_IMPLEMENTED` until the official contract is supplied.

### mock

`PROVIDER=mock` (default). Deterministic fake prices for dev/test. `verifies: false` → results stored as DEMO.

## Refresh job

`POST /api/refresh` (admin-only) triggers `runRefresh` in `src/jobs/refresh.js`:
- Single-flight lock (in-process + DB `RUNNING` row)
- Batches products, calls `provider.fetchOffers` with concurrency 2
- New offer → creates row + price history entry
- Price change → updates offer + adds history entry
- No price change → updates offer timestamps only
- Provider `fetchTimeoutMs` overrides the default 15 s per-batch timeout

## Database (Prisma / SQLite)

Models: `Product`, `Vendor`, `Offer`, `PriceHistory`, `RefreshJob`. Schema: `prisma/schema.prisma`.

Key relationships: each `Offer` belongs to a `Product` × `Vendor` pair (unique constraint). `PriceHistory` records every price change per offer.

`verificationStatus` on `Offer`: `DEMO | UNVERIFIED | VERIFIED | STALE | FAILED`. VERIFIED offers whose `lastVerifiedAt` is older than `STALE_AFTER_HOURS` are displayed as STALE in the UI.

## API endpoints

Public read: `GET /api/health`, `/api/products`, `/api/products/:id`, `/api/products/:id/history`, `/api/filters`, `/api/stats`, `/api/providers`, `/api/refresh/jobs`
Admin (Bearer token + rate-limited): `POST /api/refresh`, `POST /api/import`

## Data

`wine_dataset.json` — 8 vendors × N products, imported as DEMO. The file is synthetic (uniform region, tight timestamps). Original preserved in `data/backups/`. Import is idempotent: re-running `npm run import` is safe.

## Tests

`npm test` — 39 node:test tests.
