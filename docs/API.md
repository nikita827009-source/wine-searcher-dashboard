# API (all JSON; errors `{error:{code,message}}`)
Public read: `GET /api/health`, `/api/products?q&category&state&vendor&status&page&pageSize`, `/api/products/:id`, `/api/products/:id/history`, `/api/filters`, `/api/stats`, `/api/providers`, `/api/refresh/jobs`.
Admin (header `Authorization: Bearer <ADMIN_TOKEN>`, rate-limited): `POST /api/refresh`, `POST /api/import`.
Inputs validated with zod; pageSize capped at 100.
