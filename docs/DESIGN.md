# DESIGN
Keep existing claret/brass visual language in `fine.html` (CSS variables, Newsreader + Figtree).
## Status badges
Demo (grey-brass), Unverified (amber), Stale (orange), Verified (green, only after a successful authorized fetch), Error (red). A failed refresh never shows green.
## Screens/states
Stats row (products, vendors, verified, stale, missing-competitor, recent up/down) · filters + search · product table with pagination · product drawer: comparison table (Fine Liquors price beside each offer, diff $ / %), history chart, source link, last verified · refresh button + job status.
States: loading, empty, stale, unauthorized-source, error. Mobile: table collapses to cards, 16px gutters.
