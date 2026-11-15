
# Footprint Atlas

**Mapping the environmental footprint of our digital world.**

An environmental and agricultural trend explorer developed by **Team Goofy Goobers** for the **NASA Space Apps Challenge 2026**.

**Challenge:** [Be An Earth System Trend Detective!](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/)

## 👉 Teammates: start here

- **The product judges open = the web app** in `apps/web/`. Run `npm run web` → http://localhost:8765. **Team guide (code map, data, to-do board, deploy): [apps/web/README.md](apps/web/README.md).**
- **Demo video = Unreal Engine + Cesium** (`clients/unreal/CloudShadow/`, Andres, Windows laptop). Plan in [CLAUDE.md](CLAUDE.md) and [clients/unreal/CLOUDSHADOW_SETUP.md](clients/unreal/CLOUDSHADOW_SETUP.md).
- Deadline **Sun Nov 15, 11:59 pm**. Public link via GitHub Pages (setup in the guide §5).

## About Footprint Atlas

Footprint Atlas is an interactive environmental mapping and analysis platform designed to investigate the environmental footprint of data centers around the world.

By combining NASA Earth-observation data, geological information, environmental records, and geographic visualization, Footprint Atlas aims to help users understand how environmental conditions change around data-center regions over time.

The platform focuses on environmental indicators such as:

- **Air Quality:** Pollutant emissions, air quality, and pollution exposure.
- **Water Resources:** Water consumption, groundwater availability, water quality, and potential water stress.
- **Land and Ecosystems:** Land-surface temperature, vegetation, land-cover changes, soil conditions, and habitat indicators.
- **Noise Pollution:** Potential noise impacts associated with data-center equipment and operations.
- **Agriculture:** Environmental changes that could influence crop health, soil moisture, irrigation resources, and agricultural suitability.

### Our Goal

To make environmental data accessible and understandable through an interactive geographic experience.

Footprint Atlas aims to visualize historical environmental trends and, where scientifically validated models are available, explore conditional future scenarios associated with data-center expansion, energy demand, cooling systems, emissions, and land development.

By mapping the relationship between digital infrastructure and Earth's environmental systems, we hope to support more informed and sustainable development decisions.

### Our Approach

Footprint Atlas is designed around three main components:

1. **Environmental Data Integration** — Collect and process NASA Earth-observation data alongside geological, hydrological, and environmental datasets.
2. **Environmental Trend Analysis** — Investigate historical patterns, compare environmental indicators, and explore supported future scenarios.
3. **Interactive Geographic Visualization** — Use Unreal Engine and Cesium to explore data-center locations and surrounding environmental conditions on a 3D globe.

### Scientific Transparency

Footprint Atlas distinguishes between observed measurements, reported facility information, modeled estimates, and hypothetical scenarios.

Environmental changes observed near a data center do not necessarily establish that the facility caused those changes. Our analysis aims to preserve data provenance, identify uncertainty, and communicate scientific limitations clearly.

---

## Current scope

### What works today
| Part | What it does | Where |
|---|---|---|
| **Web explorer (the product)** | CesiumJS globe and detailed low-poly neighborhoods at 5 study areas. **Timeline 2003 → 2100**: observed site records, separately labelled trend extensions through 2035, then regional climate-period scenarios. Dated NASA maps blend smoothly; linked environmental cards and a year chart explain site versus nearby change, source coverage and uncertainty. Sourced history and reported-water labels add context in 3D. Includes mapped roads/campuses, city life, NASA GEOS-FP wind, lighting and adaptive graphics. | `apps/web/` → `npm run web` · guide: [apps/web/README.md](apps/web/README.md) |
| **NASA data pipeline** | NASA GIBS tiles decoded with official colormaps: MODIS land-surface temperature (day/night), NDVI and aerosols; Sentinel-5P TROPOMI and Aura OMI NO₂; MERRA-2 air temperature; NASA POWER weather; yearly cloud-free HLS 30 m imagery | `scripts/` → `data/cloudshadow/` |
| **Trend statistics** | Site vs. surrounding ring, seasons removed, **Mann-Kendall + Sen's slope (95% CI)**, before/after **Welch t-test** with autocorrelation-adjusted n (checked against SciPy) | `apps/web/js/stats.js` |
| **Unreal project** | UE 5.8.3 + Cesium for Unreal, level with 70 yearly NASA imagery overlays and NASA data layers, built by script | `clients/unreal/CloudShadow/` |
| **Data and backend** | Environmental Node `/v1` API, facility/emissions inventories, source adapters, cached data and background jobs; separate from the web explorer's datasets | `apps/api/`, `services/data/`, `packages/contracts/` · [Part 1 handoff](docs/data-and-backend.md) |
| **Real wind flow (Part 2)** | NASA GEOS-FP analysis winds (+ temperature, sea-level pressure) as shared `flow-field/1.0` files: particle trails on the globe and the fluid sim/clouds follow the analysed wind of each frame, 2018 onward. Direction checked against Dulles airport observations (median ~9°). [docs/flow-fields.md](docs/flow-fields.md) | `services/models/fields/`, `apps/web/js/flowfield.js`, `data/cloudshadow/fields/` |
| **Trend engine (Python, Part 2)** | Seasonal Mann-Kendall, Hamed-Rao correction (can only widen uncertainty), Sen's slope + CI, autocorrelation-adjusted t-test, control-region comparison and missing-data rules. Runs from a CLI on CSV files **and as the `trend-analysis` job in the Node API**. Research on data access and wind/pressure sources: [docs/research/data-access-and-models.md](docs/research/data-access-and-models.md) | `services/models/trends/` |
| **Giovanni series (Part 2)** | Giovanni area averages through NASA Harmony for each site: GPM rainfall, GLDAS topsoil moisture and evapotranspiration, GRACE-assimilated groundwater, OMI NO₂. Resumable and quota-guarded; needs `EARTHDATA_TOKEN`. Results for all 5 sites in the research doc; not yet shown in the web app | `services/models/trends/giovanni.py` → `data/raw/giovanni/` |

> **Where does the detailed view work?** Only at the **5 case-study sites**: timeline, yearly imagery, 3D effects, fluid sim, detailed wind box, ledger. **Anywhere else**, a click on the globe gives a live NASA trend analysis plus global map overlays and global wind trails, but no timeline or 3D effects. See [docs/coverage.md](docs/coverage.md). **How a number travels from NASA data to the screen, and what each timeline era shows:** [docs/information-flow.md](docs/information-flow.md). From 2027 to 2035, the heat, greenness, NO₂ and haze maps on the globe are **projected pixel by pixel** from each pixel's own significant NASA trend (`npm run data:trend-maps`), labelled PROJECTED; this is a trend extension, not a forecast. Data coverage per category, what each category can predict, and known gaps: [docs/issue-11-data-audit.md](docs/issue-11-data-audit.md).

**Findings so far** (details, caveats and method in [docs/cloud-shadow.md](docs/cloud-shadow.md)):
- **Ashburn, VA:** the region's air warmed **+0.71 °C/decade** (MERRA-2, p = 0.001), and the data-center area's **night-time surface heat** warmed a further **+0.25 °C/decade** beyond its surroundings (p = 0.001).
- **Memphis, TN:** greenness fell at xAI Colossus 1 (p < 0.001) and Colossus 2 (p = 0.047); NO₂ near Colossus 1 rose after the mid-2024 turbines, but the change is **borderline** (p = 0.051).
- Particle haze (aerosol optical depth): no significant increase at any site.
- **Giovanni research notes** ([details and verification audit](docs/research/data-access-and-models.md)): the team recorded regional NO₂, soil, rainfall and groundwater findings. The referenced 25 CSV exports are not present in this checkout. Groundwater units require verification from the original export; a percentile must not be interpreted as storage in millimetres. These histories remain explicitly unimported in the new evidence inventory.
- **Climate to 2100, NASA NEX-GDDP-CMIP6** ([method](docs/projections.md)), conditional scenarios with 5-model spread: by 2081–2100 the sites warm **+2.0 to +2.8 °C** under SSP2-4.5 and **+4.2 to +4.9 °C** under SSP5-8.5 (model medians). Days ≥ 35 °C rise from 28 to ~109/yr in Memphis and from 14 to ~60/yr in Ashburn under SSP5-8.5. These are regional climate scenarios, not facility effects.

### Run it
| Command | Purpose |
|---|---|
| `npm run web` | Web explorer + JSON API on http://localhost:8765 |
| `npm run web:build` / `web:preview` | Static build in `dist/web/` (what GitHub Pages serves) / preview on :8080 |
| `npm run data:nasa` / `data:weather` / `data:timeline-imagery` / `data:unreal` | Refresh NASA series / NASA POWER weather / yearly 30 m imagery / timeline + Unreal exports (Python + `pip install pillow`) |
| `npm run data:fields` | NASA GEOS-FP wind/temperature/pressure flow fields for web + Unreal (resumable, no login) |
| `python -m services.models.trends.giovanni` | Giovanni area-averaged series for the sites (needs `EARTHDATA_TOKEN`) |
| `python -m services.models.trends.cli <csv>` | Trend magnitude + significance report for any time-series CSV |
| `python -m services.models.projections.build` / `python -m services.models.projections.plume` | NEX-GDDP-CMIP6 climate projections to 2100 per site / plume χ/Q footprints (sites with on-site combustion) |
| `npm start`, `npm run check` | Environmental Node API on :3000 / backend checks after `npm run data:setup` (CI) |

The web explorer's **Environmental evidence** panel connects the five study areas to the Node job API: load weather, air quality, soil/rain and station water-quality evidence, analyze a returned series, browse source inventories and inspect climate/plume scenarios. `npm run web` starts the current environmental API and proxies it at `/api/environment`; an occupied port 3000 uses a private loopback fallback. Static hosting still provides prepared climate/wind/plume products without live jobs. River reshaping, groundwater balance, calibrated crop response and facility attribution remain unavailable.

The **Environment** readout provides large site/nearby values, annual or trailing three-year comparisons, an expandable year chart and a matching numeric table. Future selections connect the main dashboard and Cesium scene to prepared Python climate scenarios, supported trend extensions, and returned Node model jobs. Heat and rainfall retain their explicit climate windows and pathways; dispersion and agricultural exposure retain their assumptions and supported horizons. Four category controls keep these outputs accessible without treating them as facility-attributable forecasts. Map snapshots retain their actual dates and fixed scales. Water reports, resident noise complaints and construction/conversion milestones preserve source scope and precision. See [the environmental story method and limitations](docs/environment-story.md).

The local **evidence refinements** add NASA POWER annual climate simulations through 2100 alongside the existing climate ensembles, 2003–2025 regional histories with Python trend reports, five-site source audits and dated USGS river-discharge records. **Explore the evidence** contains source coverage and optional sourced-input heat, air, water and noise screening calculations. Existing models are retained; missing inputs and uncalibrated outputs remain explicit. See [the refinement guide](docs/evidence-refinements.md).

### 1. Data and backend

Our part supplies the environmental evidence and the Node.js gateway used by the analysis engine and Unreal client. Coverage is global where sources support it, with acquisition focused on **Canada and the USA**, recent records and available historical inventories. Agriculture is included; social, demographic and electricity-bill forecasting are outside our scope.

**Implementation status:** the expanded Node environmental API is connected to the web explorer through the environmental inspector and background job gateway. Downloaded source caches, run results and verification receipts remain local and are not shipped. Prepared web products and live source caches remain separate evidence products; results are not silently merged or attributed to facilities.

**Included in this backend:**

- Global OpenStreetMap data-center location acquisition and searchable facility records.
- Canadian NPRI releases and U.S. EPA NEI emissions inventories, preserving reporting IDs, units, estimation methods, missing values and provenance.
- NASA POWER meteorology, CAMS modeled air pollution, ERA5 rainfall/soil-moisture/temperature context and measured USGS station water-quality indicators.
- Two-model climate scenarios through January 1, 2050, and agricultural climate-exposure comparisons. These are not daily weather forecasts, crop-yield predictions or estimates of damage caused by a facility.
- Validated asynchronous jobs, HTTP requests/results, WebSocket progress, resumable POWER acquisition, local caching and persistent job/result files.

**Verified local coverage:**

| Source | Acquired snapshot |
| --- | --- |
| NASA POWER | Four global monthly variables, January 1981–September 2026; 549 months per variable |
| OpenStreetMap | 5,067 mapped elements; multiple elements can describe one campus |
| Canada NPRI | 34 facility-year reports for five sector candidates; nine non-null release quantities |
| U.S. EPA NEI | 23,096 pollutant/unit records across 2008, 2011, 2014, 2017, 2020 and 2023; 309 distinct source facility IDs |
| USGS water quality | 1,440 observations for one Potomac station on November 1, 2026, covering temperature, conductance, pH, dissolved oxygen and turbidity |

On November 14, 2026, the reference implementation passed **130 tests** and live verification of **17 acquisition/example jobs**. These checks verify acquisition and API behavior, not scientific causation or predictive accuracy. Regulatory sector candidates are not independently confirmed data centers, and the snapshots are not complete facility censuses.

**How Part 2 connects:** use the Node gateway to submit supported operations with `POST /v1/runs`, follow the returned HTTP status or WebSocket URL, and retrieve completed results. Browse cached locations and releases through `GET /v1/facilities` and `GET /v1/emissions`. The API base is `http://127.0.0.1:3000`; analysis code can also use the typed adapters, cache and job executor in this checkout. Keep reported emissions, environmental concentrations, measurements and climate scenarios distinct; facility identities are not automatically matched across sources.

**Run the Node backend:** install Node 24.12+ and Python 3.11+, then run `npm ci`, `npm run data:setup` and `npm start`. In another terminal use `npm run data:sync` for POWER history, `npm run data:expand` for bounded inventories/regional examples, and optional `npm run data:verify` / `npm run data:verify-expanded` after acquisition. `npm run check` runs offline checks after data dependencies are installed.

**API behavior change:** `npm start` now serves environmental `/v1` operations, and `npm run demo` reads cached POWER series, requiring `data:sync` first. Old scenario request bodies are rejected; the accounting worker/schemas remain regression fixtures, with no economic outputs in the public environmental API. The web explorer still uses `npm run web` on port 8765 and its own `/api` contract. Give the two services distinct `PORT` values. The API sends CORS headers to the local web ports and the GitHub Pages origin (override with `API_CORS_ORIGINS`).

**Part 2 jobs:** `kind: "plume-scenario"` (dispersion screening on GEOS-FP winds) and `kind: "climate-projection"` (NEX-GDDP-CMIP6 to 2100, any point) are documented in [docs/projections.md](docs/projections.md). `POST /v1/runs` with `kind: "trend-analysis"` runs the Python trend engine on a completed `series` run (`input: {runId, variable}`) or an inline series (`input: {series: {label, unit, points}}`), with an optional `control` for a target-minus-control trend. See [services/models/README.md](services/models/README.md#trend-jobs-in-the-node-api).

**Still needed in this Node API:** verified facility matching, calibrated facility-impact and agricultural models, and noise propagation/prediction. Ground noise and vegetation records can be imported with provenance, but no noise dataset or numeric NDVI observations were acquired; the public ORNL vegetation service was unavailable during setup.

See **[1. Data and backend — technical handoff](docs/data-and-backend.md)** for setup prerequisites, exact request/result examples, data locations, source limits and the extension points Part 2 should use.

### 2. Projection engine (Part 2): status

| Requirement (PDF / handoff) | Status | Where |
|---|---|---|
| Historical trend magnitude + significance (challenge core) | **Done**: Python engine + `trend-analysis` API job, validated vs SciPy, with autocorrelation safeguards | `services/models/trends/`, `apps/api/src/environment/trends.ts` |
| Real NASA inputs for water and air | **Done** for 5 sites: Giovanni rainfall, soil moisture, evapotranspiration, groundwater, OMI NO₂ (local download) | `services/models/trends/giovanni.py` |
| Shared winds/temperature/pressure for web + Unreal | **Done**: GEOS-FP flow fields 2018–2026, validated vs Dulles observations | `services/models/fields/`, `docs/flow-fields.md` |
| Baseline vs expansion comparison | **Partial**: target-minus-control trend difference, and emission scenarios via `plume-scenario`. No facility-expansion model (operating data are private) | `trend-analysis` `control`, `plume-scenario` |
| Long-range climate scenarios to 2100 | **Done**: NASA NEX-GDDP-CMIP6, 5-model ensemble, SSP2-4.5/SSP5-8.5, baseline vs 2041–2060 and 2081–2100, for the 5 sites and as a `climate-projection` API job for any point | `services/models/projections/`, `data/cloudshadow/projections/`, [docs/projections.md](docs/projections.md) |
| Air-quality transport from facility emissions | **Done as screening**: Gaussian plume on real GEOS-FP winds gives a χ/Q footprint, and concentration only with a sourced emission rate (`plume-scenario` job; Colossus 1 product). **Not done:** chemistry and monitor calibration | `services/models/projections/plume.py`, [docs/projections.md](docs/projections.md) |
| Watershed/groundwater balance, water quality | **Not implemented**: data available (Giovanni, USGS stations); no hydrological or water-quality model | — |
| Crop/agriculture response, noise propagation | **Not implemented**: needs crop yields/phenology and acoustic measurements | — |

**Parts 1 ↔ 2 ↔ web are connected:** `trend-analysis` reads POWER, CAMS, ERA5, HighResMIP and USGS runs through the shared `/v1` jobs. The browser displays source series and Python reports, prepared climate scenarios and relative plume grids, and real water-station locations. Heat/vegetation/NO₂ maps support fixed-scale snapshot differences; actual spatial rasters can also tint low-poly ground. Timeline years after 2035 show climate-period context through 2100, without annual facility-impact predictions. [Integration and remaining limits](docs/part3-integration.md). Unsupported models remain listed in [docs/projections.md](docs/projections.md#what-still-remains-outside-part-2); issue #4 still has additional optional work.
