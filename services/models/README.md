# Projection models

This directory contains the Python side of the Node -> model worker -> Unreal workflow. Python 3.11+ is sufficient for the current worker; there are no third-party dependencies, downloaded weights, external API calls, or GPU requirements.

## What runs today

`worker.py` reads **one** JSON object from stdin, computes an illustrative annual accounting scenario, emits **one** JSON result manifest to stdout, and exits. Node owns job IDs, job state, the queue, result storage, HTTP and WebSocket connections. The worker does not listen on a network port.

```sh
python services/models/worker.py < request.json
python -m unittest discover -s services/models/tests -v
```

PowerShell equivalent: `Get-Content -Raw request.json | python services/models/worker.py`.

The request envelope is `{ "runId": "a-node-generated-id", "scenario": { ... } }`. The scenario contains exactly:

```json
{
  "schemaVersion": "1.0",
  "mode": "illustrative",
  "name": "Synthetic accounting example",
  "region": {
    "id": "demo-region",
    "name": "Synthetic region",
    "bbox": [-80, 43, -79, 44]
  },
  "years": { "start": 2026, "end": 2035 },
  "assumptions": {
    "itLoadMw": 10,
    "utilization": 0.7,
    "pue": 1.3,
    "annualGrowthRate": 0.05,
    "gridKgCo2ePerKwh": 0.25,
    "wueLitresPerItKwh": 0.5,
    "electricityPricePerKwh": 0.1,
    "currency": "USD"
  }
}
```

These coordinates identify a display extent only. They do not locate a verified facility, select weather, allocate withdrawals to a watershed, or turn accounting totals into geographic predictions.

## Accounting formulas and units

For each calendar year, `hours = 24 * days_in_year` (including leap years):

```text
IT_kWh = itLoadMw * 1000 * utilization * hours
         * (1 + annualGrowthRate) ** (year - startYear)
facility_kWh = IT_kWh * pue
grid_emissions_tonnes_CO2e = facility_kWh * gridKgCo2ePerKwh / 1000
onsite_cooling_water_use_litres = IT_kWh * wueLitresPerItKwh
facility_energy_bill = facility_kWh * electricityPricePerKwh
```

WUE is defined here **per IT kWh**, so PUE must not be applied again to the water calculation. The cooling-water metric is assumed reported **use**, not a claim about net consumption, withdrawals, return flow, scarcity or contamination. The electricity bill includes only a flat assumed energy price, excluding demand charges, fixed fees and taxes. It does not estimate household rates. The emissions factor is an assumed average grid factor; this is not marginal dispatch analysis, air-quality prediction or a carbon lifecycle assessment. Onsite generators, construction and supply-chain emissions are excluded.

PUE, WUE, grid factor, utilization and price remain fixed. Growth compounds IT load from the first year; there are no weather, climate, electricity-market or capacity constraints in these formulas. All four metric records are labeled `illustrative`, with synthetic provenance and `uncertainty.status = "not_quantified"`. No confidence bands or real-world forecasts are fabricated.

## Result contract

The manifest returns `schemaVersion`, `runId`, `mode`, `modelVersion`, `scenarioName`, `region`, `years`, `provenance`, `metrics`, `unavailable`, and `layers`. Each metric has an ID, label, domain, unit, status, spatial/temporal resolution, uncertainty description and annual `{ "year": 2026, "value": 123 }` series.

Implemented accounting metric IDs:

| ID | Domain | Unit |
| --- | --- | --- |
| `facility_electricity` | `energy` | `kWh/year` |
| `grid_emissions` | `emissions` | `tonnes CO2e/year` |
| `cooling_water_use` | `water-use` | `litres/year` |
| `facility_electricity_bill` | `facility-bills` | `<currency>/year` |

`layers` is intentionally empty. Unsupported domains appear in `unavailable` with explanations, never as zero-valued results or fake map layers.

Exit status is `0` on success, `1` for malformed/invalid requests, or `2` for an unexpected model failure. Errors emit one JSON object on **stderr**, shaped as `{ "error": { "code": "INVALID_SCENARIO", "message": "..." } }`, with no stdout result. Only `illustrative` mode is accepted. The worker rejects duplicate fields, non-standard `NaN`/infinity JSON numbers, unknown fields, missing fields, booleans used as numbers, and nonfinite or out-of-range values. Input must be UTF-8 JSON and is limited to 1,000,000 bytes; it is decoded explicitly so Unicode names work independently of the Windows locale.

## Validation and horizon

| Input | Starter guardrail |
| --- | --- |
| Years | Integer 2000-2100, end >= start, end - start <= 80 |
| IT load | > 0 and <= 100,000 MW |
| Utilization | 0-1 |
| PUE | 1-3 |
| Annual growth | -0.2 to 0.25 |
| Grid factor | 0-5 kg CO2e/kWh |
| WUE | 0-20 litres/IT kWh |
| Energy price | 0-5 currency units/kWh |
| Currency | Three uppercase letters; no FX conversion |
| Scenario/region names | Non-whitespace text, at most 120 characters |
| Region ID | At most 80 ASCII letters, digits, underscores or hyphens |
| Extent | Valid longitude/latitude bounds, west < east and south < north; no dateline crossing |

These bounds are demo input guardrails, not scientifically endorsed physical limits. A 2100 result is conditional arithmetic, not demonstrated predictive skill. No regional economic, population or pollution model acquires a 2100 validity horizon merely because climate datasets extend that far.

## Models to implement next

All future adapters should declare inputs, units, supported geography, supported horizon, provenance, calibration/holdout results and uncertainty. Preserve the manifest interface while adding versioned modules.

| Domain | Required implementation and evidence |
| --- | --- |
| Air pollution and air quality | Facility/on-grid emissions inventories; meteorology and dispersion/chemistry; measured pollutant calibration; distinguish emissions, atmospheric columns and near-surface concentrations. |
| Water availability/stress | Source watershed/aquifer, withdrawals versus consumption and returns, other users, climate forcing, and calibrated hydrology/groundwater balances. |
| Water quality | Discharge volume, treatment, temperature and chemistry; upstream/background monitoring; downstream transport, dilution and receiving-water validation. |
| Electricity and bills | Time-varying load/efficiency, demand peaks, grid mix/dispatch, utility tariffs and cost allocation; household bills require their own demand and rate assumptions. |
| Employment/unemployment | Separate temporary construction and permanent jobs, local hiring/commuting, labor-force participation and regional economic baseline; do not equate facility jobs with a reduction in unemployment. |
| Population | Census baseline, births, deaths, migration and household formation; link migration to employment only through explicit justified assumptions. |
| Land/ecosystems | Observed vegetation, land cover and surface temperature; suitable habitat/ecological response models before reporting ecological damage. |
| Noise pollution | Equipment sound power/frequency spectra, cooling/generator schedules, measured background noise, receptors, terrain/buildings/barriers and weather; acoustic propagation and ground calibration; day/night indicators and jurisdiction-specific criteria. Decibels cannot be added as ordinary arithmetic values. |

STRATA can later be an optional short-range atmospheric worker. Autoregressive rollout does not make it a validated decades-ahead climate, pollution, hydrology, acoustic, electricity-market or socioeconomic model. Use climate projection ensembles and purpose-specific models for long-term scenarios, and compare scenarios with a consistent baseline.

Tests exercise a hand-calculated dimensional example, correct WUE denominator, leap-year/growth behavior, zero utilization, invalid inputs, missing capabilities, and the subprocess JSON protocol. They do not establish scientific validation of a forecast model.
