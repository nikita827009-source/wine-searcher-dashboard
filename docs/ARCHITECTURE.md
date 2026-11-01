# ARCHITECTURE
Express 5 (Node 20) serves static `fine.html` + JSON API. SQLite via Prisma (portable to PostgreSQL).
```
fine.html/index.js -> /api (routes, zod, auth, rate-limit)
   -> services: compare (pure), import, refresh job runner
   -> providers: mock | winesearcher-api (stub) | vendor feeds (future)
   -> Prisma -> SQLite
cron (node-cron) -> refresh runner (single-flight lock)
```
Layout: `src/{import,pricing,providers,jobs,routes,middleware,lib}`, `prisma/`, `tests/`, `data/{backups,reports}`.
Infra: needs a long-running Node process for cron; serverless would need an external scheduler hitting `POST /api/refresh`.
