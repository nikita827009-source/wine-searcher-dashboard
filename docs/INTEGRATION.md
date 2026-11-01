# INTEGRATION — data-source investigation (2026-10-28)

Rule: a source is "supported" only after its access method, licence and response format are verified from official documentation. Nothing below is marked supported.

| # | Option | What was verified | Status |
|---|---|---|---|
| 1 | Wine-Searcher official API / licensed data | Third-party listings ([apis.io](https://apis.io/providers/wine-searcher/)) say Wine-Searcher offers market-price and wine-check APIs; a competing scraper vendor ([Decodo](https://decodo.com/scraping/web/wine-searcher-scraper-api)) calls it an enterprise-priced trade product. **Not verified from official sources**: Wine-Searcher's own API and terms pages (`/trade/api`, `/user-terms.lml`) returned HTTP 403 to automated fetch and were not worked around. Pricing, rate limits, refresh frequency, offer URLs/IDs, commercial-use terms: **unknown**. | Blocked: client must request a quote/terms and supply a key + API contract. Adapter: `src/providers/winesearcherApi.js` (stub, reports NOT_CONFIGURED / NOT_IMPLEMENTED). |
| 2 | Vendor APIs / merchant product feeds | Not investigated per vendor. Do not assume any of the 8 imported vendors (Wine.com, Total Wine & More, Zachys, K&L, Belmont, Gary's, Astor, ReserveBar) offers a public API or feed. Each needs a documented, permitted access route (partner/affiliate feed, official API) before a provider is written. | Open: client decision per vendor. |
| 3 | Permitted public pages / other authorized integrations | Third-party scraping services exist (e.g. Apify actors), but they extract Wine-Searcher pages and may violate its terms; the vendors themselves warn to check the terms. Not used. | Rejected until written permission exists. |
| 4 | Mock provider | Implemented: `src/providers/mock.js`, deterministic, always badged Demo. | Done (dev/test only). |

## What the client must supply for a real integration
1. Written licence/API agreement with Wine-Searcher (or per-vendor feed agreements) allowing commercial use of price data in this dashboard.
2. API key(s) -> `WINESEARCHER_API_KEY` in the server `.env` (never in the browser or repo).
3. The official API contract (endpoint, params, response schema, rate limits, permitted refresh frequency) so the adapter can be built and tested; then set `PROVIDER=winesearcher-api`.
4. Product identifiers (e.g. Wine-Searcher IDs/LWIN) to map Fine Liquors SKUs to provider records, bottle size and currency per offer.

## Explicitly not done
No API keys extracted from browser traffic, no credential reuse, no anti-bot bypass, no scraping. The old Puppeteer `/api/scrape` endpoint (spoofed user agent, `--no-sandbox`) and all fabricated fallback prices were removed.
