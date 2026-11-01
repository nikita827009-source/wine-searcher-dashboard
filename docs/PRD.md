# PRD — Fine Liquors Competitor Pricing Dashboard
## Objective
Compare Fine Liquors prices with competitor offers across the US; show lowest verified competitor price, price changes over time, and the source + last verification time of every offer.
## Principles
- Never present data as live/verified unless fetched from a real, authorized source.
- Never fabricate URLs, vendor IDs, prices, availability or timestamps.
- Imported JSON (4,925 products / 39,400 offers, synthetic-looking) is labelled **Demo / Unverified**.
## Users
Fine Liquors pricing managers (read dashboard, trigger refresh) and an admin (import, provider config).
## Requirements
Product/vendor/offer listing, filters (category, state, vendor, verification), search (name, brand, SKU), comparison table, price history, refresh + job status, freshness/verification badges, pagination, responsive UI.
## Out of scope
Scraping Wine-Searcher or any site in violation of terms; credential reuse; anti-bot bypass.
## Success
Safe re-import, tested formulas, accurate status labels, mock-provider refresh working, missing credentials never break the app.
