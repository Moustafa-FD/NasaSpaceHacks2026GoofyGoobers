# Future scenarios: climate to 2100 and air-dispersion screening

Two Part 2 models from the PDF's projection-engine list. Both are **conditional scenarios**: they answer "what if", not "what will happen". Each result carries its assumptions, its evidence label and how its uncertainty is expressed.

## 1. Climate projections to 2100 (NASA NEX-GDDP-CMIP6)

| | |
| --- | --- |
| Source | NASA NEX-GDDP-CMIP6: bias-corrected, statistically downscaled CMIP6 daily climate, 0.25°, CC0 (Thrasher et al. 2022). Read point by point through the NCCS THREDDS NetCDF Subset Service; no login. |
| Ensemble | ACCESS-CM2, GFDL-ESM4, MPI-ESM1-2-HR, MRI-ESM2-0, UKESM1-0-LL (different modelling centres and climate sensitivities) |
| Scenarios | SSP2-4.5 (intermediate) and SSP5-8.5 (very high emissions) |
| Windows | Baseline 1995–2014, mid-century 2041–2060, late century 2081–2100. Each window is sampled with evenly spaced years (4 per window for the committed site products) |
| Metrics | Annual mean temperature (°C), days per year with daily max ≥ 35 °C, annual precipitation (mm/year). Counts and totals are normalised to 365.25 days, so 360-day model calendars compare fairly |
| Uncertainty | **Model spread** (median, min and max of each model's change from its own baseline). This is not a confidence interval |
| Evidence label | `climate-scenario` |

- **Products:** `data/cloudshadow/projections/<site>.json`, built with `python -m services.models.projections.build`. Raw CSVs are cached in `data/raw/nexgddp/`; re-runs fetch only what is missing.
- **Any point:** API job `{"kind": "climate-projection", "point": {...}, "perWindow": 1-4}`.

Limits: a 0.25° cell (~25 km) is regional climate. It does not resolve a facility or its own heat, and it is not a weather forecast. Precipitation change is less certain than temperature change, so read the model spread.

A bug caught during the build: without `temporal=all`, the THREDDS subset service returns a **single day** per file. That silently produced winter-only "annual" values (Memphis at 5.6 °C instead of ~17 °C). The client now requests all days and refuses responses with fewer than 300 days, and a regression test covers it.

## 2. Air-dispersion screening (Gaussian plume on real winds)

The PDF asks for "onsite emissions; transport and chemistry to estimate pollutant concentrations". The transport part is implemented as a **screening** model:

| | |
| --- | --- |
| Winds | Real NASA GEOS-FP analysed 10 m wind at the site. The 5 case-study sites use their prepared flow fields (about 106 instants, 2018–2026); any other point is extracted on demand |
| Dispersion | Gaussian plume with ground reflection, Briggs (1973) urban or rural σy/σz, valid 100 m–10 km downwind |
| Stability | Pasquill class from 10 m wind speed and day/night (computed sun elevation). **Assumptions:** moderate insolation by day; at least 4/8 cloud at night |
| Stack | **Effective stack height must be given** (no default in the API). Plume rise needs exhaust temperature and velocity, which have not been published for these facilities |
| Output | Long-term average ground-level **χ/Q** (s/m³, dilution per unit emission) on a 16 km grid, plus named receptors (e.g. Boxtown, 3.1 km from Colossus 1) |
| Concentration | Only when the request includes an emission rate **and its source** (permit, inventory or stated assumption); then µg/m³ = χ/Q × Q × 10⁶ |
| Evidence label | `scenario` |

Not modelled: chemistry (NO → NO₂, secondary PM2.5), deposition, building downwash, terrain, the mixing-height cap and background pollution. **This is not a regulatory model (AERMOD) and not a measurement.** For Colossus 1, the measured TROPOMI NO₂ signal stays borderline (p = 0.051). The plume shows *where* emissions would tend to go, not *how much* is there.

- **Static product:** `data/cloudshadow/plumes/colossus1.json`, built with `python -m services.models.projections.plume`. Its effective height is an assumed 20 m, labelled in the file.
- **API:** `{"kind": "plume-scenario", "siteId": "colossus1" | "point": {...}, "effectiveHeightM": 20, "landUse": "urban", "emission"?: {"rateGs", "source", "pollutant"}}`.

## What still remains outside Part 2

| Item | Why it isn't built | What would unlock it |
| --- | --- | --- |
| Facility air-quality with chemistry, calibrated to monitors | No published emission rates or stack parameters for these facilities; secondary chemistry needs a chemical transport model | Permit/inventory emission rates and stack data, EPA AQS monitors, then AERMOD or CMAQ |
| Watershed and groundwater balance; water quality | Facility withdrawals, discharges and receiving-water chemistry are not public for these sites | Utility or permit withdrawal data, NPDES discharge records, USGS gauges and NHDPlus |
| Crop response / yield | Vegetation indices are not yields; no crop type, phenology or yield observations | USDA NASS yields and the Cropland Data Layer, plus a crop model |
| Noise propagation | Satellites do not measure sound; no equipment sound-power or background measurements | On-site acoustic measurements and an ISO 9613 propagation model |
| Facility expansion → emissions/water | The scope excludes energy/bill forecasting, and facility operating data are private | Operator-reported capacity, PUE/WUE and generator schedules |
