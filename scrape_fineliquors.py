"""
Scrapes fineliquors.com via Shopify products.json API.
Uses DataImpulse residential proxy to avoid rate limits.
Output: fineliquors_raw.json + wine_dataset.json (for npm run import)
"""

import json, time, re, sys
from pathlib import Path

PROXY_HOST = "gw.dataimpulse.com"
PROXY_PORT = "823"
PROXY_USER = "4f080acee55b99e4597f"
PROXY_PASS = "05576bacbd4ff11b"

BASE     = "https://fineliquors.com"
LIMIT    = 250
SLEEP    = 2.0      # seconds between pages

OUT_RAW     = Path("D:/wine/fineliquors_raw.json")
OUT_DATASET = Path("D:/wine/winesearcher/wine-scraper/wine_dataset.json")

PROXIES = {
    "http":  f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_HOST}:{PROXY_PORT}",
    "https": f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_HOST}:{PROXY_PORT}",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
}


ZYTE_API_KEY = "e64447ec91dd4ea6baabdbf1789bc131"

def fetch_via_zyte(url: str) -> str | None:
    import requests as req
    try:
        r = req.post(
            "https://api.zyte.com/v1/extract",
            auth=(ZYTE_API_KEY, ""),
            json={"url": url, "httpResponseBody": True},
            timeout=60,
        )
        r.raise_for_status()
        import base64
        body_b64 = r.json().get("httpResponseBody", "")
        return base64.b64decode(body_b64).decode("utf-8") if body_b64 else None
    except Exception as e:
        print(f"    Zyte error: {e}")
        return None


def fetch_page(session, page: int) -> list[dict]:
    url = f"{BASE}/products.json?limit={LIMIT}&page={page}"
    # Try direct first
    for attempt in range(1, 3):
        try:
            r = session.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 429:
                print(f"    429 — falling back to Zyte...")
                break
            r.raise_for_status()
            return r.json().get("products", [])
        except Exception as e:
            print(f"    Direct error (attempt {attempt}): {e}")
            time.sleep(3)

    # Fallback to Zyte API
    body = fetch_via_zyte(url)
    if body:
        try:
            return json.loads(body).get("products", [])
        except Exception as e:
            print(f"    Zyte JSON parse error: {e}")
    return []


def map_category(product_type: str, tags: list[str], title: str) -> str:
    t   = (product_type or "").lower()
    tg  = [x.lower() for x in tags]
    ttl = title.lower()

    if t in ("champagne",) or any(x in tg for x in ("champagne", "sparkling")) \
            or re.search(r"champagne|prosecco|cava|cr[eé]mant|sekt|sparkling|brut\b|blanc de", ttl):
        return "Champagne & Sparkling"
    if t in ("whiskey", "whisky", "bourbon", "scotch") \
            or any(x in tg for x in ("whiskey", "whisky", "bourbon", "scotch", "rye")) \
            or re.search(r"\bwhisky\b|\bwhiskey\b|\bbourbon\b|\bscotch\b|\brye\b", ttl):
        return "Whiskey & Bourbon"
    if t in ("tequila", "mezcal") or any(x in tg for x in ("tequila", "mezcal")) \
            or re.search(r"\btequila\b|\bmezcal\b", ttl):
        return "Tequila & Mezcal"
    if t in ("cognac", "armagnac", "brandy", "rum") \
            or any(x in tg for x in ("cognac", "armagnac", "brandy", "rum")) \
            or re.search(r"\bcognac\b|\barmagnac\b|\bbrandy\b|\brum\b", ttl):
        return "Cognac, Brandy & Rum"
    if t in ("gin", "vodka") or any(x in tg for x in ("gin", "vodka")) \
            or re.search(r"\bgin\b|\bvodka\b", ttl):
        return "Gin & Vodka"

    # Wine — detect white vs red from name
    if re.search(r"chardonnay|sauvignon|riesling|pinot gris|pinot grigio|chenin|viognier|"
                 r"albarino|albar|gewurz|white wine|chablis|meursault|mersault|puligny|"
                 r"montrachet|muscadet|vermentino|soave|gavi|greco|fiano|falanghina|"
                 r"verdicchio|gr[uü]ner|veltliner|verdejo|godello|ribolla", ttl):
        return "White Wine"
    return "Red Wine"


def extract_vintage(title: str):
    m = re.match(r"^(\d{4})\s", title)
    if m:
        yr = int(m.group(1))
        if 1900 <= yr <= 2030:
            return str(yr)
    return None


def parse_price(s) -> float | None:
    try:
        n = float(re.sub(r"[^0-9.]", "", str(s)))
        return n if n > 0 else None
    except Exception:
        return None


def convert(raw: list[dict]) -> list[dict]:
    now = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000000+00:00")
    dataset = []
    seen = set()

    for p in raw:
        handle = p.get("handle", "")
        if handle in seen:
            continue
        seen.add(handle)

        title = (p.get("title") or "").strip()
        if not title:
            continue

        # Only include products with at least one available (in-stock) variant
        all_variants = [v for v in (p.get("variants") or []) if parse_price(v.get("price"))]
        if not all_variants:
            continue
        available_variants = [v for v in all_variants if v.get("available")]
        variants = available_variants if available_variants else []
        if not variants:
            continue  # skip sold-out products

        # Use cheapest available variant
        cheapest = min(variants, key=lambda v: parse_price(v["price"]))
        price = parse_price(cheapest["price"])

        vintage  = extract_vintage(title)
        wine_name = re.sub(r"^\d{4}\s+", "", title).strip()
        tags     = p.get("tags") or []
        ptype    = p.get("product_type") or ""
        category = map_category(ptype, tags, title)

        # Region: pick tags that look like places (not category keywords)
        skip_tags = {"wine", "champagne", "usa", "france", "italy", "spain", "whiskey",
                     "bourbon", "scotch", "tequila", "cognac", "gin", "vodka", "rum",
                     "sparkling", "mezcal", "brandy", "armagnac", "port", "madeira",
                     "fineliquors", "new arrivals", "rare", "limited"}
        region_tags = [t for t in tags if t.lower() not in skip_tags and len(t) > 2]
        region = ", ".join(region_tags[:3]) if region_tags else None

        dataset.append({
            "id":           f"{BASE}/products/{handle}",
            "wineName":     wine_name,
            "vintage":      vintage,
            "region":       region,
            "category":     category,
            "clientPrice":  price,
            "competitors":  [],
            "lastUpdated":  now,
        })

    return dataset


def main():
    import requests
    session = requests.Session()

    all_products = []
    page = 1

    print("Scraping fineliquors.com ...")
    while True:
        print(f"  Page {page}...", end=" ", flush=True)
        products = fetch_page(session, page)
        if not products:
            print("empty — done.")
            break
        all_products.extend(products)
        print(f"{len(products)} products (total: {len(all_products)})")
        if len(products) < LIMIT:
            print("  Last page reached.")
            break
        page += 1
        time.sleep(SLEEP)

    print(f"\nTotal fetched: {len(all_products)}")
    OUT_RAW.write_text(json.dumps(all_products, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Raw saved -> {OUT_RAW}")

    dataset = convert(all_products)
    OUT_DATASET.write_text(json.dumps(dataset, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Dataset saved -> {OUT_DATASET}  ({len(dataset)} products)")

    from collections import Counter
    cats = Counter(p["category"] for p in dataset)
    print("\nBy category:")
    for cat, cnt in cats.most_common():
        print(f"  {cat:<30} {cnt}")

    prices = sorted(p["clientPrice"] for p in dataset)
    print(f"\nPrice range: ${prices[0]} – ${prices[-1]}")
    print(f"Median: ${prices[len(prices)//2]}")


if __name__ == "__main__":
    main()
