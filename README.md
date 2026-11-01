# Wine Searcher Dashboard

A competitor pricing dashboard for a fine liquor store. Scrapes live market prices from Wine-Searcher, stores them in a local database, and displays them in a clean browser UI with price change alerts and auto-refresh scheduling.

---

## Features

- **Pricing table** — compare your store's prices against multiple competitors side-by-side
- **7 categories** — Red Wine, White Wine, Champagne & Sparkling, Whiskey & Bourbon, Tequila & Mezcal, Cognac/Brandy/Rum, Gin & Vodka
- **Auto refresh scheduling** — set a cron schedule (daily, every 6h, etc.) from the UI; no server restart needed
- **Price change alerts** — in-app bell notifications whenever competitor prices shift beyond your threshold (1–20%)
- **Optional email alerts** — configure SMTP in `.env` to receive alerts by email
- **758 real products** imported from Wine-Searcher across 11 categories
- **39 automated tests** (node:test)

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 + Express 5 |
| Database | SQLite via Prisma ORM |
| Scheduling | node-cron |
| Email | nodemailer |
| Frontend | Vanilla JS + fine.html (no build step) |
| Data scraping | Python + Zyte API / Playwright |

---

## Quick Start

```bash
cd winesearcher/wine-scraper

# 1. Environment
cp .env.example .env
# Edit .env — set ADMIN_TOKEN to any secret string

# 2. Dependencies
npm install

# 3. Database
npx prisma migrate deploy

# 4. Import wine data
npm run import          # imports wine_dataset.json (idempotent)

# 5. Start server
npm start               # http://localhost:5000/fine.html
```

---

## Project Structure

```
wine/
├── winesearcher/
│   ├── fine.html                   # Dashboard UI
│   ├── index.js                    # Browser API client
│   └── wine-scraper/               # Express backend
│       ├── server.js               # Entry point, cron + alert wiring
│       ├── src/
│       │   ├── app.js              # Express routes
│       │   ├── lib/
│       │   │   ├── db.js           # Prisma client
│       │   │   ├── alertStore.js   # File-based alert persistence
│       │   │   ├── settings.js     # File-based settings persistence
│       │   │   └── mailer.js       # nodemailer email alerts
│       │   ├── jobs/refresh.js     # Refresh job runner
│       │   ├── import/             # Dataset importers (JSON, CSV, Apify)
│       │   ├── pricing/compare.js  # Price comparison utils
│       │   └── providers/          # mock | winesearcher-api
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/
│       ├── tests/                  # 39 node:test tests
│       └── .env.example
└── scraper.py                      # Python scraper (Zyte API + Playwright)
```

---

## API Endpoints

### Public
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Server health check |
| GET | `/api/products` | Product list with offers |
| GET | `/api/products/:id` | Single product |
| GET | `/api/products/:id/history` | Price history |
| GET | `/api/filters` | Categories + vendors |
| GET | `/api/stats` | Summary stats |
| GET | `/api/providers` | Active provider info |
| GET | `/api/refresh/jobs` | Recent refresh jobs |
| GET | `/api/settings` | Current settings |
| GET | `/api/alerts` | Recent price alerts |

### Admin (requires `Authorization: Bearer <ADMIN_TOKEN>`)
| Method | Path | Description |
|---|---|---|
| POST | `/api/refresh` | Trigger price refresh |
| POST | `/api/import` | Import dataset |
| POST | `/api/settings` | Update settings / cron schedule |
| POST | `/api/alerts/read` | Mark alerts as read |
| DELETE | `/api/alerts` | Clear all alerts |

---

## Environment Variables

```env
PORT=5000
DATABASE_URL="file:./dev.db"
ADMIN_TOKEN=your-secret-token-here

# Provider: mock (default) or winesearcher-api
PROVIDER=mock
WINESEARCHER_API_KEY=

# Auto refresh cron (e.g. "0 8 * * *" = daily at 8am, empty = disabled)
REFRESH_CRON=

# Hours before a verified price is marked stale
STALE_AFTER_HOURS=48

# Email alerts (optional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

---

## Running Tests

```bash
cd winesearcher/wine-scraper
npm test
# 39 tests across api, compare, import, refresh
```

---

## Data Import Options

```bash
npm run import              # Default: wine_dataset.json
npm run import:dry          # Validate without writing to DB
npm run import:csv          # Import from CSV_DATASET_FILE in .env
npm run import:apify        # Import from Apify dataset JSON
```

CSV format: `wine_name,vintage,category,client_price,vendor,competitor_price,location,rating`

---

## Deployment Notes

- Requires a long-running Node process for `REFRESH_CRON` (node-cron). For serverless, trigger `POST /api/refresh` from an external scheduler.
- SQLite supports one writer — migrate to PostgreSQL for multi-instance: change `provider` in `prisma/schema.prisma` and update `DATABASE_URL`.
- Set `CORS_ORIGINS` to your domain, put the app behind HTTPS, and keep `.env` out of source control.
