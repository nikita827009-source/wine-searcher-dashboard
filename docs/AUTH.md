# AUTH
Read endpoints open on the internal network; mutating endpoints (refresh, import) require a bearer `ADMIN_TOKEN` from env (constant-time compare). Missing token config => those endpoints return 503, not open access. CORS restricted to `CORS_ORIGINS`. Secrets only in server env; never logged or returned.
