# Facility and water evidence audit

The five prepared `data/cloudshadow/site-audit/<site>.json` products connect actual cached regulatory records and USGS gauge observations to an explicit coverage/identity audit. They do not assert facility causation or automatically assign a nearby inventory to a generated building.

## Acquired evidence

- Each site has up to twelve real USGS stream locations, with source coordinates, straight-line distance, discovery request and SHA-256.
- Up to three selected gauge locations have time-series metadata. Metadata retains parameter codes, units, statistic identifiers and source first/last timestamps. Those endpoints do not guarantee uninterrupted observations.
- All five sites have 365 recorded daily mean discharge values for calendar 2025. The Memphis study sites share the same Mississippi River gauge; this is one shared measurement source, not two independent series or two attributed campus effects.

| Study | Gauge | Geographic meaning |
| --- | --- | --- |
| Colossus 1 / Colossus 2 | USGS-07032000, Mississippi River at Memphis | Regional receiving-water context; campus connectivity not established |
| Ashburn | USGS-01644280, Broad Run near Leesburg | Nearby gauge context; not the entire Potomac watershed or a campus withdrawal |
| Abilene | USGS-08083430, Elm Creek at Abilene | Stream measurement, not a municipal supply allocation |
| The Dalles | USGS-14105700, Columbia River at The Dalles | Columbia gauge measurement, not facility consumption or evaporation |

Original source values, `ft^3/s` units, daily dates/timestamps, time-series IDs, approval status and qualifiers remain in the product. The web helper can convert ft³/s to m³/s with the exact factor `0.028316846592`. A summary requires at least 90% of calendar days; unavailable years remain unavailable. No 2025 gauge record becomes a future flow forecast.

The raw USGS responses are cached under ignored `tmp/site-audit-source/`. Prepared products preserve their public request URL, retrieval timestamp and response SHA-256, allowing verification without shipping credentials or unnecessary source payloads.

## Facility identity

The audit reads the acquired EPA NEI sector-filtered snapshots for 2008, 2011, 2014, 2017, 2020 and 2023 and contributed OSM locations. Each pollutant/quantity/unit/year remains independent. Records are not summed across pollutants or labeled ambient air quality. Source emission methods and missing quantities remain unchanged.

The 2023 inventory predates the selected Memphis and Abilene build-outs. No nearby candidate in those snapshots is not a zero-emissions result. Ashburn is a regional cluster and has multiple nearby regulatory candidates; none is automatically the selected campus. NPRI and the existing source library remain available and unchanged, but the five US study-area audits do not assign Canadian reports to US sites.

The State of Oregon's primary [SIP21-01 resolution](https://www.oregon.gov/biz/Publications/Boards/Business%20Oregon%20Commission/2021/December/sip%6021-01~Resolution%20%28website%29.pdf) identifies Design LLC within the Google group. That operator relationship is recorded for EIS19091511. The EIS location is separate from the selected original-campus marker, so its exact campus association remains a **candidate**. Operator affiliation, distance or a similar name alone cannot promote that record.

Manual decisions live in `data/cloudshadow/site-audit-decisions.json`. A reviewed association needs the exact study/source/source-facility IDs, a real review date, reviewer, statement and an HTTPS primary-record citation. The default file contains no confirmed facility associations. Even a confirmed identity does not establish environmental causation: `attributionEligible` remains false.

## Reproduce and extend

From a checkout containing acquired inventory caches:

```powershell
node scripts/prepare-site-evidence.mjs --cache-root data/processed/environment --refresh-water
```

For the existing multi-worktree setup, the default inventory location is the sibling `NasaSpaceHacks2026GoofyGoobers/data/processed/environment`. Supply `--cache-root` explicitly elsewhere. Missing EPA snapshots stop the script before existing audits are overwritten. `--rebuild-water` reprocesses already-cached public responses without refreshing them. A normal run retains prepared water evidence and rebuilds the inventory audit.

USGS queries use the fixed public OGC v1 API, a bounded geographic box, at most 500 stream locations, twelve retained locations per study, and three inspected time-series metadata sets. The acquisition budget is forty requests with 25-second per-request timeouts. It is not a national survey. Failed downloads retain previous prepared observations and expose the error rather than filling values.

Browser consumers use `loadSiteAudit(siteId)`, `summarizeSiteAudit(result)` and `siteAuditWaterReadings(result, year)` from `apps/web/js/site-audit.js`. The latter returns dated gauge means with explicit validity, original units and optional m³/s conversion. The loader validates schema and exact site identity and keeps failed loads retryable.

## Primary references

- [USGS OGC API documentation](https://api.waterdata.usgs.gov/docs/ogcapi/): monitoring locations, time-series metadata and daily observations.
- [USGS migration/field guide](https://api.waterdata.usgs.gov/docs/ogcapi/migration/): time-series identity, period-of-record metadata and missing values.
- [EPA point-source identity guidance](https://www.epa.gov/system/files/documents/2024-04/point-source-best-practices-training_508-.pdf): EIS facility identities must match the inventory record.
- [NASA challenge Resources](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/?tab=resources): Hydrology Time Series, Giovanni and SWOT are complementary hydrological sources. These gauge products do not claim to contain SWOT elevations or inferred river morphology.

Validation: `node --test tests/site-audit.test.js` covers identity-review requirements, no automatic attribution, actual five-site source coverage, zero/missing values, annual coverage, units and loader isolation.
