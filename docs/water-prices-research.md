# Nearest-city water price evidence

Researched 15 November 2026. The city card uses the same nearest mapped city as electricity. These are **water-only tariff examples at 3,000 US gallons per month**, not average household bills, measured household consumption, data-center water consumption, or a causal estimate of data-center effects on rates. Sewer, stormwater, taxes, deposits and non-recurring fees are excluded.

The compact extraction is `data/cloudshadow/water-prices/index.json`; `apps/web/js/water-price-data.js` calculates the example from its recorded tariffs. Source URLs, effective/adoption dates, meter assumptions and billing periods are retained. Rates require manual review when updated; no national/state average replaces an unverified local tariff.

## Verified coverage and calculations

| Nearest mapped city | Supplier / primary source | Water-only example at 3,000 gallons/month | Date / limitation |
| --- | --- | --- | --- |
| West Memphis, AR | [City water fees and rates](https://westmemphisar.gov/315/Fees-Rates) | **$15.91/month**: $13 residential 3/4-inch base plus $0.0969 per hundred gallons for the first 6,700 gallons | Official page is **undated**. Publication/effective year stays unknown. Always a reference, including when the timeline is in 2026. The stated net discount is already included; it is not applied twice. |
| Horn Lake, MS | [Municipal resolution 11-02-24, November 5, 2024 minutes, water column p. 42](https://www.hornlake.org/media/Board%20Meetings/Final%20Minutes%202022/11-05-24%20minutes%20final.pdf) | **$14.44/month** residential minimum includes up to 4,500 gallons; each additional 750 gallons or part costs $4.01 | Adoption date is verified; current/effective date is not. **2024 reference only**. The separate sewer column and the separate Horn Lake Water Association tariff are excluded. |
| Ashburn, VA | [Loudoun Water residential rates](https://www.loudounwater.org/schedule-rates-residential-customers) | **$25.43/month equivalent** in 2026: ($45.97 quarterly basic charge + 9 thousand gallons × $3.37)/3 | Effective **2026-01-01**; quarterly volume tiers are applied before dividing the whole bill by three. Example is the water component of a normal combined-service account; separate sewer and single-service-only surcharge excluded. |
| Impact, TX | Residential supplier and applicable tariff not verified | **Unavailable** | Nearby Abilene's tariff is not substituted. A centroid being nearby does not establish a utility service territory. |
| Dallesport, WA | [Dallesport Water District's 2026 master schedule](https://img1.wsimg.com/blobby/go/c152fd94-b494-4e11-a165-bbb41dbf2651/Master%20Rate%20Schedule%202026%20PDF.pdf), linked from the [district website](https://dallesportwater.org/) | **$69.54/month**: $65.64 per ERU base + 3 × $1.30 | Effective **2026-01-01**, one ERU, residential 5/8- or 3/4-inch meter. Klickitat PUD's Dallesport industrial-water and sewer schedules are different services and are not used. |

Higher-use calculations preserve the published blocks. West Memphis charges $1.164 per thousand gallons above 6,700. Dallesport's successive 10,000-gallon blocks cost $1.30, $1.45, $1.65, $1.90 and $2.20 per thousand, then $2.55 above 50,000. Loudoun's quarterly 2026 tiers are $3.37 for the first 25,000 gallons, $9.34 for the next 25,000 and $12.52 beyond 50,000. Horn Lake's increments round upward, so 4,501 gallons costs one additional $4.01 increment.

## Historical and future years

Loudoun's [published Schedule A](https://www.loudounwater.org/sites/default/files/FINAL%20customer%20notification%20letter.pdf), together with the [board's final approval explanation](https://www.loudounwater.org/information-rate-changes), supports **2025, 2026 and approved 2027** schedules. At 3,000 gallons/month, the water-only equivalents are $23.77, $25.43 and $27.23 respectively. The 2027 amount is an approved scheduled rate, **not a statistical forecast**.

No water-price predictive model is supplied. If the selected year has no verified tariff, `kind: reference` retains the tariff's actual date or explicitly states that its date is unknown. It does **not** label today's tariff as the past or future price. `forecastAvailable` remains false; missing baselines and price-change percentages remain null. Changes in water consumption, supply, water quality or NASA environmental indicators do not establish changes in household tariffs.

Validation: `node --test tests/water-price-data.test.js` checks per-hundred-gallon conversion, net discount handling, minimum included volumes and partial increments, quarterly tier conversion, all supported example bills, water/sewer separation, scheduled rates versus forecasts, unknown dates, unmatched years, missing supplier evidence and shared loading.
