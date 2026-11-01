"""
Convert wine_searcher_data.json (flat scraper output)
→ wine_searcher_converted.json (importer format)
"""
import json, re
from datetime import datetime, timezone

ABBR_TO_STATE = {
    'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
    'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
    'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
    'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
    'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
    'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire',
    'NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina',
    'ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania',
    'RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee',
    'TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington',
    'WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','DC':'District of Columbia',
}

CATEGORY_MAP = {
    'red-wine':   'Red Wine',
    'white-wine':  'White Wine',
    'rose-wine':   'Rosé Wine',
    'sparkling':   'Sparkling Wine',
    'dessert':     'Dessert Wine',
    'whiskey':     'Whiskey',
    'rum':         'Rum',
    'brandy':      'Brandy',
    'gin':         'Gin',
    'vodka':       'Vodka',
    'beer-other':  'Beer / Other',
}

def parse_location(loc: str) -> str:
    """'CA: Los Angeles' → 'California, USA'"""
    if not loc:
        return ''
    m = re.match(r'^([A-Z]{2})\s*:\s*(.+)$', loc.strip())
    if m:
        abbr, city = m.group(1), m.group(2).strip()
        state = ABBR_TO_STATE.get(abbr, abbr)
        return f"{state}, USA"
    return loc

def clean_name(name: str, vintage: str) -> str:
    """Strip leading vintage year from name if present."""
    if vintage and name.startswith(vintage):
        return name[len(vintage):].strip()
    return name.strip()

def main():
    raw = json.load(open('wine_searcher_data.json', encoding='utf-8'))
    now_iso = datetime.now(timezone.utc).isoformat()

    converted = {}
    skipped = 0

    for r in raw:
        price_str = r.get('price', '').strip()
        if not price_str:
            skipped += 1
            continue
        try:
            price = float(price_str.replace(',', ''))
        except ValueError:
            skipped += 1
            continue
        if price <= 0:
            skipped += 1
            continue

        product_id = r['product_url'] or f"{r['name']}|{r['vintage']}"
        category   = CATEGORY_MAP.get(r['category'], r['category'])
        vintage    = r.get('vintage') or None
        wine_name  = clean_name(r['name'], vintage)
        location   = parse_location(r.get('merchant_location', ''))

        if product_id not in converted:
            converted[product_id] = {
                'id':          product_id,
                'wineName':    wine_name,
                'vintage':     vintage,
                'region':      r.get('region') or None,
                'category':    category,
                'clientPrice': price,   # placeholder: cheapest known competitor
                'competitors': [],
                'lastUpdated': now_iso,
            }

        converted[product_id]['competitors'].append({
            'vendor':   r['merchant_name'],
            'price':    price,
            'location': location or None,
        })

        # clientPrice = min of all seen competitor prices
        converted[product_id]['clientPrice'] = min(
            converted[product_id]['clientPrice'], price
        )

    out = dict(converted)
    with open('wine_searcher_converted.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"Products:  {len(out)}")
    print(f"Skipped:   {skipped}")
    print(f"Saved →    wine_searcher_converted.json")

if __name__ == '__main__':
    main()
