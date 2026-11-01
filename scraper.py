"""
Wine-Searcher marketplace scraper – full paginated, all USA categories
Zyte API (primary) → Playwright+stealth (fallback)

Output: wine_searcher_data.json  +  wine_searcher_data.csv
"""

import json, time, csv, os, sys, zipfile
from bs4 import BeautifulSoup

# ── Config ──────────────────────────────────────────────────────────────────
ZYTE_API_KEY   = "e64447ec91dd4ea6baabdbf1789bc131"
ZENROWS_API_KEY = ""

PROXY_HOST = "gw.dataimpulse.com"
PROXY_PORT = "823"
PROXY_USER = "4f080acee55b99e4597f"
PROXY_PASS = "05576bacbd4ff11b"

BASE = "https://www.wine-searcher.com"

_USA = "?sl-ctr=USA"
CATEGORIES = [
    # ── Red Wine subcategories ────────────────────────────────────────────────
    ("red-wine",            f"{BASE}/marketplace/red-wine{_USA}"),
    ("cabernet-sauvignon",  f"{BASE}/marketplace/cabernet-sauvignon{_USA}"),
    ("pinot-noir",          f"{BASE}/marketplace/pinot-noir{_USA}"),
    ("merlot",              f"{BASE}/marketplace/merlot{_USA}"),
    ("syrah",               f"{BASE}/marketplace/syrah{_USA}"),
    ("zinfandel",           f"{BASE}/marketplace/zinfandel{_USA}"),
    ("malbec",              f"{BASE}/marketplace/malbec{_USA}"),
    ("sangiovese",          f"{BASE}/marketplace/sangiovese{_USA}"),
    ("tempranillo",         f"{BASE}/marketplace/tempranillo{_USA}"),
    ("nebbiolo",            f"{BASE}/marketplace/nebbiolo{_USA}"),
    ("grenache",            f"{BASE}/marketplace/grenache{_USA}"),
    ("cabernet-franc",      f"{BASE}/marketplace/cabernet-franc{_USA}"),
    # ── White Wine subcategories ──────────────────────────────────────────────
    ("white-wine",          f"{BASE}/marketplace/white-wine{_USA}"),
    ("chardonnay",          f"{BASE}/marketplace/chardonnay{_USA}"),
    ("sauvignon-blanc",     f"{BASE}/marketplace/sauvignon-blanc{_USA}"),
    ("riesling",            f"{BASE}/marketplace/riesling{_USA}"),
    ("pinot-gris",          f"{BASE}/marketplace/pinot-gris{_USA}"),
    ("gewurztraminer",      f"{BASE}/marketplace/gewurztraminer{_USA}"),
    ("viognier",            f"{BASE}/marketplace/viognier{_USA}"),
    ("albarino",            f"{BASE}/marketplace/albarino{_USA}"),
    ("chenin-blanc",        f"{BASE}/marketplace/chenin-blanc{_USA}"),
    # ── Rosé, Sparkling, Dessert ──────────────────────────────────────────────
    ("rose-wine",           f"{BASE}/marketplace/rose-wine{_USA}"),
    ("sparkling",           f"{BASE}/marketplace/sparkling-wine{_USA}"),
    ("champagne",           f"{BASE}/marketplace/champagne{_USA}"),
    ("prosecco",            f"{BASE}/marketplace/prosecco{_USA}"),
    ("dessert",             f"{BASE}/marketplace/dessert-wine{_USA}"),
    # ── Whiskey subcategories ─────────────────────────────────────────────────
    ("whiskey",             f"{BASE}/marketplace/whiskey{_USA}"),
    ("bourbon",             f"{BASE}/marketplace/bourbon{_USA}"),
    ("scotch-whisky",       f"{BASE}/marketplace/scotch-whisky{_USA}"),
    ("irish-whiskey",       f"{BASE}/marketplace/irish-whiskey{_USA}"),
    ("japanese-whisky",     f"{BASE}/marketplace/japanese-whisky{_USA}"),
    ("rye-whiskey",         f"{BASE}/marketplace/rye-whiskey{_USA}"),
    # ── Other spirits ─────────────────────────────────────────────────────────
    ("tequila",             f"{BASE}/marketplace/tequila{_USA}"),
    ("mezcal",              f"{BASE}/marketplace/mezcal{_USA}"),
    ("cognac",              f"{BASE}/marketplace/cognac{_USA}"),
    ("armagnac",            f"{BASE}/marketplace/armagnac{_USA}"),
    ("rum",                 f"{BASE}/marketplace/rum{_USA}"),
    ("brandy",              f"{BASE}/marketplace/brandy{_USA}"),
    ("gin",                 f"{BASE}/marketplace/gin{_USA}"),
    ("vodka",               f"{BASE}/marketplace/vodka{_USA}"),
]

MAX_PAGES   = 5    # wine-searcher caps at 5 pages per category (75 listings each)
SLEEP_BETWEEN = 1  # seconds between Zyte requests (be polite)

OUT_JSON = "wine_searcher_data.json"
OUT_CSV  = "wine_searcher_data.csv"

CSV_FIELDS = [
    "category", "name", "region", "vintage", "price", "currency",
    "tax_status", "rating", "size", "stock", "stock_count",
    "merchant_name", "merchant_location", "merchant_url",
    "verified", "delivery_options",
    "offer_id", "product_url", "merchant_product_url", "image_url",
    "scraped_page",
]


# ── Fetchers ────────────────────────────────────────────────────────────────

def fetch_zyte(url: str) -> str | None:
    if not ZYTE_API_KEY:
        return None
    try:
        import requests as req
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


def fetch_playwright(url: str) -> str | None:
    try:
        from playwright.sync_api import sync_playwright
        from playwright_stealth import Stealth

        proxy_cfg = {
            "server":   f"http://{PROXY_HOST}:{PROXY_PORT}",
            "username": PROXY_USER,
            "password": PROXY_PASS,
        }
        with sync_playwright() as p:
            browser = p.chromium.launch(
                channel="chrome",
                headless=False,
                proxy=proxy_cfg,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            ctx = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                timezone_id="America/New_York",
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
            )
            page = ctx.new_page()
            try:
                Stealth().apply_stealth_sync(page)
            except Exception:
                pass
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            except Exception:
                pass
            try:
                page.wait_for_selector("div.card.marketplace-card", timeout=20_000)
            except Exception:
                pass
            time.sleep(3)
            try:
                html = page.content()
            except Exception:
                html = ""
            try:
                browser.close()
            except Exception:
                pass
        if not html or "px-captcha" in html or "Access to this page" in html:
            return None
        return html
    except Exception as e:
        print(f"    Playwright error: {e}")
        return None


def fetch(url: str) -> str | None:
    html = fetch_zyte(url)
    if html:
        return html
    print("    Zyte failed, trying Playwright…")
    return fetch_playwright(url)


# ── Parser ───────────────────────────────────────────────────────────────────

def parse_cards(html: str, category: str, page_num: int) -> tuple[list[dict], str | None]:
    """Returns (listings, next_page_url | None)."""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("div.card.marketplace-card")
    listings = []

    for card in cards:
        def t(sel):
            el = card.select_one(sel)
            return el.get_text(strip=True) if el else ""

        def a(sel, attr_name):
            el = card.select_one(sel)
            return el.get(attr_name, "") if el else ""

        # Price parts
        integer    = t(".price__integer-part")
        fractional = t(".price__fractional-part")
        currency   = t(".price__currency-symbol").strip()
        price      = f"{integer}{fractional}" if integer else ""

        # Stock: separate status text from count in parens
        raw_stock  = " ".join(t(".offer-status").split())
        import re
        count_match = re.search(r"\((\d+)\)", raw_stock)
        stock_count = count_match.group(1) if count_match else ""
        stock_status = re.sub(r"\s*\(\d+\)", "", raw_stock).strip()

        # Merchant
        store_el   = card.select_one("a.store-name")
        store_text = store_el.get_text(strip=True) if store_el else ""
        store_href = store_el.get("href", "") if store_el else ""

        # Parse "Name (STATE: City)" → merchant_name + merchant_location
        loc_match = re.match(r"^(.+?)\s+\(([^)]+)\)\s*$", store_text)
        if loc_match:
            merchant_name = loc_match.group(1).strip()
            merchant_loc  = loc_match.group(2).strip()
        else:
            merchant_name = store_text
            merchant_loc  = ""

        merchant_url = f"{BASE}{store_href}" if store_href.startswith("/") else store_href

        # Delivery
        delivery_spans = card.select(".delivery-info svg + span")
        delivery_types = list(dict.fromkeys(
            s.get_text(strip=True) for s in delivery_spans if s.get_text(strip=True)
        ))

        # Verified
        verified = card.select_one(".retailer_badge_image-verified") is not None

        # Image
        img_el  = card.select_one("img.offer-card__img")
        img_src = img_el.get("src", "") if img_el else ""
        if img_src.startswith("/"):
            img_src = BASE + img_src.split("?")[0]  # clean query params

        # Product URL (wine-searcher compare page)
        ws_href  = a(".product-info h6 a", "href")
        prod_url = f"{BASE}{ws_href}" if ws_href else ""

        # Direct merchant product URL
        merch_prod_url = a("a.js-offer-link", "href")

        # Size
        size = t(".badge-other")

        # Rating
        rating_el = card.select_one(".badge-rating")
        rating    = rating_el.get_text(strip=True).split("/")[0].strip() if rating_el else ""

        # Region + possible vintage
        region_text = t(".discover-card-info-text")
        vintage = ""
        if region_text:
            yr = re.match(r"^(\d{4})\s+(.+)$", a(".product-info h6 a", "title") or "")
            # vintage is encoded in the product name (e.g. "2021 Sine Qua Non …")
            name_el = card.select_one(".product-info h6 a")
            name_text = name_el.get_text(strip=True) if name_el else ""
            yr2 = re.match(r"^(\d{4})\s", name_text)
            if yr2:
                vintage = yr2.group(1)

        name_el   = card.select_one(".product-info h6 a")
        name_text = name_el.get_text(strip=True) if name_el else ""

        listings.append({
            "category":            category,
            "name":                name_text,
            "region":              region_text,
            "vintage":             vintage,
            "price":               price,
            "currency":            currency or "USD",
            "tax_status":          t(".price__tax-status"),
            "rating":              rating,
            "size":                size,
            "stock":               stock_status,
            "stock_count":         stock_count,
            "merchant_name":       merchant_name,
            "merchant_location":   merchant_loc,
            "merchant_url":        merchant_url,
            "verified":            verified,
            "delivery_options":    ", ".join(delivery_types),
            "offer_id":            card.get("data-offer-id", ""),
            "product_url":         prod_url,
            "merchant_product_url": merch_prod_url,
            "image_url":           img_src,
            "scraped_page":        page_num,
        })

    # Next page URL — try "Show more" button first, then URL-based &pg= fallback
    more_btn = soup.select_one("button.js-load-more[data-src]")
    if more_btn:
        next_path = more_btn.get("data-src", "")
        next_url  = f"{BASE}{next_path}" if next_path.startswith("/") else None
    else:
        next_url = "USE_PG_PARAM"  # signal caller to bump &pg= counter

    return listings, next_url


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    all_listings: list[dict] = []
    seen_product_urls: set[str] = set()  # deduplicate by product URL across categories

    csv_file = open(OUT_CSV, "w", newline="", encoding="utf-8")
    writer   = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
    writer.writeheader()

    for cat_name, base_url in CATEGORIES:
        print(f"\n{'='*55}")
        print(f"  Category: {cat_name}")
        print(f"{'='*55}")

        page_num    = 1
        use_pg_param = False  # switches to True once we detect &pg= mode

        while page_num <= MAX_PAGES:
            if use_pg_param or page_num > 1:
                sep = "&" if "?" in base_url else "?"
                current_url = f"{base_url}{sep}page={page_num}"
            else:
                current_url = base_url

            print(f"  Page {page_num}: {current_url}")
            html = fetch(current_url)
            if not html:
                print(f"  Failed to fetch page {page_num}, stopping category.")
                break

            listings, next_url = parse_cards(html, cat_name, page_num)

            if next_url == "USE_PG_PARAM":
                use_pg_param = True

            new_count = 0
            for row in listings:
                purl = row.get("product_url") or row.get("offer_id") or ""
                if purl and purl in seen_product_urls:
                    continue
                if purl:
                    seen_product_urls.add(purl)
                all_listings.append(row)
                writer.writerow(row)
                new_count += 1

            csv_file.flush()
            print(f"  -> {new_count} new listings (total so far: {len(all_listings)})", flush=True)

            if new_count == 0:
                print(f"  No more pages for {cat_name}.", flush=True)
                break

            # If button gave a real URL, use it; otherwise keep using &pg= counter
            if next_url and next_url != "USE_PG_PARAM":
                page_num += 1
                current_url = next_url
                time.sleep(SLEEP_BETWEEN)
                continue

            page_num += 1
            time.sleep(SLEEP_BETWEEN)

    csv_file.close()

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(all_listings, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*55}")
    print(f"  DONE: {len(all_listings)} total unique listings")
    print(f"  JSON -> {OUT_JSON}")
    print(f"  CSV  -> {OUT_CSV}")

    # Summary by category
    from collections import Counter
    by_cat = Counter(r["category"] for r in all_listings)
    for cat, cnt in by_cat.most_common():
        print(f"    {cat:<20} {cnt} listings")


if __name__ == "__main__":
    main()
