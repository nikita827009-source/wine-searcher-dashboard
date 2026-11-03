"""
Two-step competitor price pipeline:

Step 1 (scrape):  Scrapes wine-searcher marketplace pages via Zyte.
                  Keeps ALL offers (no dedup) so we get multiple vendors per wine.
                  Output: ws_offers_raw.json

Step 2 (match):   Fuzzy-matches ws offers to Fine Liquors products by name+vintage.
                  Builds wine_dataset.json with competitors[] populated.
                  Then calls `npm run import` to push into the DB.

Usage:
    python add_competitors.py scrape       # run Zyte scraper
    python add_competitors.py match        # match + rebuild dataset
    python add_competitors.py all          # both steps
"""

import json, time, re, sys, subprocess
from pathlib import Path
from difflib import SequenceMatcher
from bs4 import BeautifulSoup

ZYTE_API_KEY   = "e64447ec91dd4ea6baabdbf1789bc131"
BASE_WS        = "https://www.wine-searcher.com"
FL_DATASET     = Path("D:/wine/winesearcher/wine-scraper/wine_dataset.json")
WS_RAW_OUT     = Path("D:/wine/ws_offers_raw.json")
_USA           = "?sl-ctr=USA"
SLEEP_SEC      = 1.5
MAX_PAGES      = 5

CATEGORIES = [
    ("red-wine",           f"{BASE_WS}/marketplace/red-wine{_USA}"),
    ("cabernet-sauvignon", f"{BASE_WS}/marketplace/cabernet-sauvignon{_USA}"),
    ("pinot-noir",         f"{BASE_WS}/marketplace/pinot-noir{_USA}"),
    ("merlot",             f"{BASE_WS}/marketplace/merlot{_USA}"),
    ("syrah",              f"{BASE_WS}/marketplace/syrah{_USA}"),
    ("zinfandel",          f"{BASE_WS}/marketplace/zinfandel{_USA}"),
    ("malbec",             f"{BASE_WS}/marketplace/malbec{_USA}"),
    ("chardonnay",         f"{BASE_WS}/marketplace/chardonnay{_USA}"),
    ("sauvignon-blanc",    f"{BASE_WS}/marketplace/sauvignon-blanc{_USA}"),
    ("riesling",           f"{BASE_WS}/marketplace/riesling{_USA}"),
    ("white-wine",         f"{BASE_WS}/marketplace/white-wine{_USA}"),
    ("champagne",          f"{BASE_WS}/marketplace/champagne{_USA}"),
    ("sparkling",          f"{BASE_WS}/marketplace/sparkling-wine{_USA}"),
    ("prosecco",           f"{BASE_WS}/marketplace/prosecco{_USA}"),
    ("whiskey",            f"{BASE_WS}/marketplace/whiskey{_USA}"),
    ("bourbon",            f"{BASE_WS}/marketplace/bourbon{_USA}"),
    ("scotch-whisky",      f"{BASE_WS}/marketplace/scotch-whisky{_USA}"),
    ("japanese-whisky",    f"{BASE_WS}/marketplace/japanese-whisky{_USA}"),
    ("rye-whiskey",        f"{BASE_WS}/marketplace/rye-whiskey{_USA}"),
    ("irish-whiskey",      f"{BASE_WS}/marketplace/irish-whiskey{_USA}"),
    ("tequila",            f"{BASE_WS}/marketplace/tequila{_USA}"),
    ("mezcal",             f"{BASE_WS}/marketplace/mezcal{_USA}"),
    ("cognac",             f"{BASE_WS}/marketplace/cognac{_USA}"),
    ("armagnac",           f"{BASE_WS}/marketplace/armagnac{_USA}"),
    ("rum",                f"{BASE_WS}/marketplace/rum{_USA}"),
    ("brandy",             f"{BASE_WS}/marketplace/brandy{_USA}"),
    ("gin",                f"{BASE_WS}/marketplace/gin{_USA}"),
    ("vodka",              f"{BASE_WS}/marketplace/vodka{_USA}"),
    ("rose-wine",          f"{BASE_WS}/marketplace/rose-wine{_USA}"),
    ("dessert",            f"{BASE_WS}/marketplace/dessert-wine{_USA}"),
]


# ── Zyte ─────────────────────────────────────────────────────────────────────

def fetch_zyte(url: str) -> str | None:
    import requests as req
    try:
        r = req.post("https://api.zyte.com/v1/extract",
            auth=(ZYTE_API_KEY, ""),
            json={"url": url, "browserHtml": True},
            timeout=90)
        r.raise_for_status()
        html = r.json().get("browserHtml", "")
        if not html or "px-captcha" in html:
            return None
        return html
    except Exception as e:
        print(f"    Zyte error: {e}")
        return None


# ── Parser ────────────────────────────────────────────────────────────────────

def parse_marketplace(html: str, category: str, page: int) -> list[dict]:
    soup  = BeautifulSoup(html, "html.parser")
    cards = soup.select("div.card.marketplace-card")
    results = []

    for card in cards:
        def t(sel): e = card.select_one(sel); return e.get_text(strip=True) if e else ""
        def a(sel, attr): e = card.select_one(sel); return e.get(attr,"") if e else ""

        integer    = t(".price__integer-part")
        fractional = t(".price__fractional-part")
        price_str  = f"{integer}{fractional}".replace(",","")
        try: price = float(price_str)
        except: continue
        if price <= 0: continue

        # Merchant
        store_el   = card.select_one("a.store-name")
        store_text = store_el.get_text(strip=True) if store_el else ""
        loc_m = re.match(r"^(.+?)\s+\(([^)]+)\)\s*$", store_text)
        if loc_m:
            vendor   = loc_m.group(1).strip()
            location = loc_m.group(2).strip()
        else:
            vendor   = store_text
            location = ""
        if not vendor: continue

        # Wine name (from product card title)
        name_el   = card.select_one(".product-info h6 a")
        name_text = name_el.get_text(strip=True) if name_el else ""
        if not name_text: continue

        # Vintage from name prefix
        vm = re.match(r"^(\d{4})\s", name_text)
        vintage = vm.group(1) if vm else None
        wine_name = re.sub(r"^\d{4}\s+","",name_text).strip()

        offer_id    = card.get("data-offer-id","")
        ws_href     = a(".product-info h6 a","href")
        product_url = f"{BASE_WS}{ws_href}" if ws_href else ""

        results.append({
            "wsName":    wine_name,
            "wsVintage": vintage,
            "vendor":    vendor,
            "price":     price,
            "location":  location,
            "offer_id":  offer_id,
            "productUrl": product_url,
            "category":  category,
            "page":      page,
        })

    return results


# ── Step 1: Scrape ────────────────────────────────────────────────────────────

def do_scrape():
    # Resume if partial
    if WS_RAW_OUT.exists():
        existing = json.loads(WS_RAW_OUT.read_text(encoding="utf-8"))
        done_cats = {e["_cat_page"] for e in existing if "_cat_page" in e}
        all_offers = [e for e in existing if "_cat_page" not in e]
        print(f"Resuming: {len(all_offers)} offers already scraped, {len(done_cats)} pages done")
    else:
        all_offers = []
        done_cats  = set()

    for cat_name, base_url in CATEGORIES:
        for page in range(1, MAX_PAGES + 1):
            key = f"{cat_name}:{page}"
            if key in done_cats:
                continue

            sep = "&" if "?" in base_url else "?"
            url = f"{base_url}{sep}page={page}" if page > 1 else base_url
            print(f"  {cat_name} p{page}...", end=" ", flush=True)

            html = fetch_zyte(url)
            if not html:
                print("failed")
                all_offers.append({"_cat_page": key})  # mark done even on failure
                time.sleep(SLEEP_SEC)
                continue

            offers = parse_marketplace(html, cat_name, page)
            if not offers:
                print("empty (last page)")
                all_offers.append({"_cat_page": key})
                break

            all_offers.extend(offers)
            all_offers.append({"_cat_page": key})
            print(f"{len(offers)} offers (total: {len([o for o in all_offers if '_cat_page' not in o])})")

            WS_RAW_OUT.write_text(json.dumps(all_offers, indent=2, ensure_ascii=False), encoding="utf-8")
            time.sleep(SLEEP_SEC)

    real = [o for o in all_offers if "_cat_page" not in o]
    print(f"\nTotal WS offers scraped: {len(real)}")
    return real


# ── Step 2: Match ─────────────────────────────────────────────────────────────

STOP_WORDS = {"the","a","an","and","of","in","for","with","de","la","le","les",
              "du","des","et","en","al","el","di","da","von","den","der","das",
              "old","year","years","reserve","barrel","select","special","single",
              "malt","cask","edition","limited","bottle","bottles","wine","wines",
              "whiskey","whisky","bourbon","cognac","tequila","vodka","gin","rum",
              "kentucky","straight","scotch","blended","vintage","release","lower",
              "fill","upper","proof","strength","cask","strength","bottled"}

def normalize(name: str) -> str:
    n = re.sub(r"^\d{4}\s+", "", name)
    # Strip FL-specific suffixes like "- 2019 Release", "(Lower Fill)", etc.
    n = re.sub(r"\s*[-–]\s*\d{4}\s+release.*", "", n, flags=re.IGNORECASE)
    n = re.sub(r"\s*\([^)]*\)\s*$", "", n)
    n = re.sub(r"[^\w\s]", " ", n.lower())
    n = re.sub(r"\s+", " ", n).strip()
    return n

def tokenize(name: str) -> set[str]:
    tokens = set(normalize(name).split())
    # Remove pure numbers unless they look like ages (10-40 year)
    tokens = {t for t in tokens if not re.match(r"^\d+$", t) or (2 <= len(t) <= 2 and 10 <= int(t) <= 50)}
    return tokens - STOP_WORDS if len(tokens - STOP_WORDS) > 0 else tokens

def similarity(a: str, b: str) -> float:
    ta, tb = tokenize(a), tokenize(b)
    if not ta or not tb: return 0.0
    inter = ta & tb
    union = ta | tb
    jaccard = len(inter) / len(union)
    seq = SequenceMatcher(None, normalize(a), normalize(b)).ratio()
    return 0.6 * jaccard + 0.4 * seq

MATCH_THRESHOLD = 0.32  # lower = more matches

def do_match():
    fl_dataset = json.loads(FL_DATASET.read_text(encoding="utf-8"))
    ws_raw     = json.loads(WS_RAW_OUT.read_text(encoding="utf-8"))
    ws_offers  = [o for o in ws_raw if "_cat_page" not in o]

    print(f"Matching {len(ws_offers)} WS offers against {len(fl_dataset)} FL products...")

    # Index FL products for fast lookup
    fl_index = {}
    for p in fl_dataset:
        key = normalize(p["wineName"])
        fl_index.setdefault(key, []).append(p)

    # For each WS offer, find best FL match
    # Build a score matrix: fl_product -> [competing offers]
    from collections import defaultdict
    fl_competitors = defaultdict(list)  # fl_product_id -> list of {vendor, price, location}

    matched = 0
    for offer in ws_offers:
        ws_name = offer["wsName"]
        ws_vin  = offer.get("wsVintage")

        best_score = 0.0
        best_fl    = None

        for fl_p in fl_dataset:
            score = similarity(ws_name, fl_p["wineName"])
            # Vintage bonus
            fl_vin = fl_p.get("vintage")
            if ws_vin and fl_vin and ws_vin == fl_vin:
                score = min(1.0, score + 0.15)
            elif ws_vin and fl_vin and ws_vin != fl_vin:
                score = max(0.0, score - 0.1)

            if score > best_score:
                best_score = score
                best_fl = fl_p

        if best_fl and best_score >= MATCH_THRESHOLD:
            fl_competitors[best_fl["id"]].append({
                "vendor":   offer["vendor"],
                "price":    offer["price"],
                "location": offer["location"],
                "_score":   round(best_score, 3),
            })
            matched += 1

    print(f"Matched {matched} WS offers to FL products")
    print(f"FL products with at least 1 competitor: {len(fl_competitors)}")

    # Update FL dataset with competitor data
    updated = 0
    for p in fl_dataset:
        comps = fl_competitors.get(p["id"], [])
        if comps:
            # Sort by price ascending, remove _score
            comps.sort(key=lambda c: c["price"])
            p["competitors"] = [{"vendor": c["vendor"], "price": c["price"], "location": c["location"]} for c in comps]
            updated += 1

    FL_DATASET.write_text(json.dumps(fl_dataset, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Updated {updated} products with competitor data -> {FL_DATASET}")
    return updated


# ── Import ────────────────────────────────────────────────────────────────────

def do_import():
    print("\nRunning npm run import ...")
    result = subprocess.run(
        ["npm.cmd", "run", "import"],
        cwd="D:/wine/winesearcher/wine-scraper",
        capture_output=True, text=True, timeout=300,
        shell=False
    )
    print(result.stdout[-2000:] if result.stdout else "")
    if result.returncode != 0:
        print("Import error:", result.stderr[-500:])
    else:
        print("Import complete.")


# ── Entry ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"

    if cmd in ("scrape", "all"):
        do_scrape()

    if cmd in ("match", "all"):
        updated = do_match()
        if updated > 0:
            do_import()
        else:
            print("No matches found — check WS raw data.")
