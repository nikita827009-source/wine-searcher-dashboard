# US wine & spirits vendors — starter directory

**Status: UNVERIFIED.** Compiled from general knowledge on 2026-10-28, not from an official register.
This is NOT every US vendor (thousands of licensed retailers exist, and each state licenses separately).
Names, states, and whether a vendor still operates must be checked before use. No websites, vendor IDs,
APIs or prices are listed because none were verified. Many vendors can only ship to some states
(direct-to-consumer alcohol shipping laws vary by state).

Column "In data?" = already present in `wine_dataset.json` / the database.

## Already in the dataset (8)
| Vendor | HQ state | Type |
|---|---|---|
| Wine.com | CA | National online |
| Total Wine & More | MD | National chain + online |
| Zachys Wine Auctions | NY | Retail + auction |
| K&L Wine Merchants | CA | Retail + online |
| Belmont Wine Exchange | CA | Retail |
| Gary's Wine & Marketplace | NJ | Retail + online |
| Astor Wines & Spirits | NY | Retail + online |
| ReserveBar | NY | Online spirits |

## Listed in the old UI only, no data and not verified (6)
Cana Wine Company, Wooden Cork, Feng Fine Wine and Spirits, Continental Wine & Spirits, El Cerrito Liquor, Whiskey Source.
These came from the prototype's hardcoded list; their existence/states were never checked.

## Candidates to verify (from general knowledge)
### National / multi-state online and chains
| Vendor | HQ state | Type |
|---|---|---|
| BevMo | CA | Chain + online |
| Binny's Beverage Depot | IL | Chain + online |
| Spec's Wines, Spirits & Finer Foods | TX | Chain + online |
| Twin Liquors | TX | Chain |
| Goody Goody Liquor | TX | Chain |
| ABC Fine Wine & Spirits | FL | Chain |
| Fine Wine & Good Spirits | PA | State-operated retail |
| Wine Library | NJ | Retail + online |
| Vivino | CA | Marketplace |
| Caskers | CA | Online spirits |
| Flaviar | NY | Online spirits / club |
| Minibar Delivery | CA | Delivery marketplace |
| Saucey | CA | Delivery |
| Wine Access | CA | Online |
| Last Bottle Wines | CA | Online flash sales |
| Vinfolio | CA | Online / storage |
| Wine Chateau | NJ | Retail + online |
| Winc | CA | Subscription |
| Naked Wine | CA | Online |
| Costco Wine | WA | Membership warehouse |
| Sam's Club | AR | Membership warehouse |

### California
Hi-Time Wine Cellars, The Wine House (Los Angeles), Wally's Wine & Spirits, Bottle Barn, Woodland Hills Wine Company, Vintage Wine Estates retail outlets (if still operating), K&L (listed above).

### New York / New Jersey / Northeast
Sherry-Lehmann, Acker Wines (retail + auction), Chambers Street Wines, Crush Wine & Spirits, Union Square Wines & Spirits, Park Avenue Liquor Shop, Frugal MacDoogal, Joe Canal's Discount Liquor (NJ), Bottle King (NJ).

### Midwest / South / Mountain
Liquor Barn and The Party Source (KY), Seelbach's (KY, bourbon), Schaefer's / Sam's Wines & Spirits (IL), Applejack Wine & Spirits (CO), Total Wine & More (listed above).

### Auction houses
Zachys (listed above), Acker, Hart Davis Hart (IL), WineBid (CA), Spectrum Wine Auctions (CA), Unicorn Auctions (CA/NY).

## Notes
- Drizly (delivery marketplace) was shut down by its owner, so it is not a candidate.
- Grocery chains (Kroger, Safeway/Albertsons, Trader Joe's) sell alcohol but are rarely useful price comparators for fine/rare bottles.
- To make a vendor usable in the dashboard it needs a verified access route (official API, merchant feed, or written permission) — see INTEGRATION.md. Until then it can be listed but has no prices.
