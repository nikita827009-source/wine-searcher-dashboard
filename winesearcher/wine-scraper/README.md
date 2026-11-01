# Fine Liquors Competitor Pricing Dashboard

Express 5 + Prisma (SQLite) API serving `../fine.html`. Docs: `/docs` (PRD, ARCHITECTURE, DATABASE, API, AUTH, INTEGRATION, SETUP, TESTING, DEBUGGING, ...).

## Run
```
cd winesearcher/wine-scraper
cp .env.example .env        # set ADMIN_TOKEN
npm install
npx prisma migrate deploy   # or: npm run db:migrate (dev)
npm run import:dry          # validate + report only
npm run import              # idempotent import of wine_dataset.json
npm start                   # http://localhost:5000/fine.html
npm test                    # node:test, 39 tests
```
Refresh from the UI asks for the ADMIN_TOKEN (kept in sessionStorage). Or: `curl -XPOST localhost:5000/api/refresh -H "Authorization: Bearer $ADMIN_TOKEN"`.

## Data honesty
- `wine_dataset.json` looks synthetic (one region for every product, all timestamps within 74 ms, exactly 8 offers per product). It is imported as **Demo**; see `data/reports/import-*.md`.
- Only a provider that `verifies` (a real, authorized source) can produce **Verified** offers. The mock provider never does. `winesearcher-api` is a stub until the client supplies a key and API contract (docs/INTEGRATION.md).
- Original file is untouched; content-addressed copies live in `data/backups/`. `fine.html.orig` is the pre-change UI.

## Deploy notes
Needs a long-running Node 20 process for `REFRESH_CRON` (node-cron). For serverless, call `POST /api/refresh` from an external scheduler. SQLite is a single file with one writer; move to PostgreSQL (change `provider` in `prisma/schema.prisma`, `DATABASE_URL`, re-run migrations) for multi-instance deployments. Restrict `CORS_ORIGINS`, put the app behind HTTPS, and keep `.env` out of source control.
