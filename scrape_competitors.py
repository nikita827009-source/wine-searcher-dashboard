"""
Scrapes competitor prices from wine-searcher.com for each Fine Liquors product.

For each FL product:
  1. Constructs wine-searcher search URL: /find/{name}/{vintage}/usa
  2. Fetches via Zyte API (browserHtml) to bypass bot protection
  3. Parses vendor listings (price + merchant name + location)
  4. Writes to competitors_found.json for import

Output: competitors_found.json  (later imported via add_competitors.js)

Usage:
    python scrape_competitors.py              # scrape all
    python scrape_competitors.py --limit 50  # first 50 products only
"""

import json, time, re, sys, os, argparse
from pathlib import Path
from bs4 import BeautifulSoup

ZYTE_API_KEY = "e64447ec91dd4ea6baabdbf1789bc131"
BASE_WS      = "https://www.wine-searcher.com"
DATASET_PATH = Path("D:/wine/winesearcher/wine-scraper/wine_dataset.json")
OUT_PATH     = Path("D:/wine/competitors_found.json")
SLEEP_SEC    = 1.2   # between Zyte requests

# ── Zyte fetch ──────────────────────────────────────────────────────────────

def fetch_zyte(url: str) -> str | None:
    import requests as req
    try:
        r = req.post(
            "https://api.zyte.com/v1/extract",
            auth=(ZYTE_API_KEY, ""),
            json={"url": url, "browserHtml": True},
            timeout=90,
        )
        r.raise_for_status()
        html = r.json().get("browserHtml", "")
        if not html or "px-captcha" in html:
            return None
        return html
    except Exception as e:
        print(f"    Zyte error: {e}")
        return None

# ── URL builder ─────────────────────────────────────────────────────────────

def ws_search_url(name: str, vintage: str | None) -> str:
    slug = re.sub(r"[^\w\s-]", "", name.lower())
    slug = re.sub(r"[\s]+", "+", slug.strip())
    slug = re.sub(r"-+", "+", slug)
    yr   = vintage if vintage and vintage.isdigit() else "0"
    return f"{BASE_WS}/find/{slug}/{yr}/usa"

# ── Parser ───────────────────────────────────────────────────────────────────

def parse_ws_page(html: str) -> list[dict]:
    """Parse a wine-searcher find/product page for vendor price listings."""
    soup = BeautifulSoup(html, "html.parser")
    results = []

    # wine-searcher uses several card patterns; try both marketplace and product pages
    cards = soup.select("div.card.marketplace-card") or soup.select("div.offer-info")
    for card in cards:
        # Price
        integer    = _t(card, ".price__integer-part")
        fractional = _t(card, ".price__fractional-part")
        price_str  = f"{integer}{fractional}".replace(",", "")
        try:
            price = float(price_str) if price_str else None
        except ValueError:
            price = None
        if not price or price <= 0:
            continue

        # Merchant name + location
        store_el = card.select_one("a.store-name") or card.select_one(".merchant-name")
        store_text = store_el.get_text(strip=True) if store_el else ""
        loc_match  = re.match(r"^(.+?)\s+\(([^)]+)\)\s*$", store_text)
        if loc_match:
            merchant = loc_match.group(1).strip()
            location = loc_match.group(2).strip()
        else:
            merchant = store_text
            location = ""

        if not merchant:
            continue

        results.append({"vendor": merchant, "price": price, "location": location})

    return results


def _t(el, sel):
    n = el.select_one(sel)
    return n.get_text(strip=True) if n else ""


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max products to process (0=all)")
    parser.add_argument("--skip", type=int, default=0, help="Skip first N products")
    args = parser.parse_args()

    dataset = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
    if args.skip:
        dataset = dataset[args.skip:]
    if args.limit:
        dataset = dataset[:args.limit]

    print(f"Processing {len(dataset)} products...")

    # Load existing results to allow resuming
    if OUT_PATH.exists():
        existing = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        done_ids = {e["id"] for e in existing}
        print(f"  Resuming — {len(done_ids)} already done")
    else:
        existing = []
        done_ids = set()

    results = list(existing)
    found_count = 0

    for i, product in enumerate(dataset):
        pid = product["id"]
        if pid in done_ids:
            continue

        name    = product["wineName"]
        vintage = product.get("vintage")
        url     = ws_search_url(name, vintage)

        print(f"  [{i+1}/{len(dataset)}] {name[:50]}", end=" ... ", flush=True)
        html = fetch_zyte(url)
        if not html:
            print("no HTML")
            results.append({"id": pid, "competitors": []})
            done_ids.add(pid)
            time.sleep(SLEEP_SEC)
            continue

        competitors = parse_ws_page(html)
        results.append({"id": pid, "competitors": competitors})
        done_ids.add(pid)

        if competitors:
            found_count += 1
            print(f"{len(competitors)} vendors (cheapest ${competitors[0]['price']})")
        else:
            print("no matches")

        # Save progress every 25 products
        if len(results) % 25 == 0:
            OUT_PATH.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

        time.sleep(SLEEP_SEC)

    OUT_PATH.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone. {found_count}/{len(dataset)} products had competitor prices.")
    print(f"Saved -> {OUT_PATH}")


if __name__ == "__main__":
    main()
