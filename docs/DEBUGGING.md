# DEBUGGING
Import issues: read `data/reports/import-*.md`. Refresh issues: `GET /api/refresh/jobs` (errorSummary). Provider NOT_CONFIGURED: set the env var named in `/api/providers`. DB reset (dev only): delete `prisma/dev.db` and re-migrate (requires approval on real data).
