
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
| **Web explorer (the product)** | CesiumJS 3D globe with 5 case studies (xAI Colossus 1 & 2 in Memphis, Data Center Alley in Ashburn VA, Stargate Abilene TX, Google The Dalles OR). **Timeline slider 2003 → 2035**: yearly NASA 30 m ground imagery, 3D ring of yearly local signals, heat dome + embers, GPU fluid weather field driven by NASA wind, turbine plume, clouds/rain, golden-hour/night lighting with NASA city lights; projected years shown as "if the trend continues" with 95% CIs. Plus click-anywhere live analysis, guided tour, trend statistics and a sourced ledger. | `apps/web/` → `npm run web` · guide: [apps/web/README.md](apps/web/README.md) |
| **NASA data pipeline** | NASA GIBS tiles decoded with official colormaps: MODIS land-surface temperature (day/night), NDVI and aerosols; Sentinel-5P TROPOMI and Aura OMI NO₂; MERRA-2 air temperature; NASA POWER weather; yearly cloud-free HLS 30 m imagery | `scripts/` → `data/cloudshadow/` |
| **Trend statistics** | Site vs. surrounding ring, seasons removed, **Mann-Kendall + Sen's slope (95% CI)**, before/after **Welch t-test** with autocorrelation-adjusted n (checked against SciPy) | `apps/web/js/stats.js` |
| **Unreal project** | UE 5.8.3 + Cesium for Unreal, level with 70 yearly NASA imagery overlays and NASA data layers, built by script | `clients/unreal/CloudShadow/` |
| **Data and backend** | Environmental Node `/v1` API, facility/emissions inventories, source adapters, cached data and background jobs; separate from the web explorer's datasets | `apps/api/`, `services/data/`, `packages/contracts/` · [Part 1 handoff](docs/data-and-backend.md) |
| **Real wind flow (Part 2)** | NASA GEOS-FP analysis winds (+ temperature, sea-level pressure) as shared `flow-field/1.0` files: particle trails on the globe and the fluid sim/clouds follow the analysed wind of each frame, 2018 onward. Direction checked against Dulles airport observations (median ~9°). [docs/flow-fields.md](docs/flow-fields.md) | `services/models/fields/`, `apps/web/js/flowfield.js`, `data/cloudshadow/fields/` |
| **Trend engine (Python, Part 2)** | Seasonal Mann-Kendall, Hamed-Rao correction, Sen's slope + CI, autocorrelation-adjusted t-test, control-region comparison and missing-data rules, run from a CLI on CSV files (not yet called by the API). Research on data access and wind/pressure sources: [docs/research/data-access-and-models.md](docs/research/data-access-and-models.md) | `services/models/trends/` |

**Findings so far** (details, caveats and method in [docs/cloud-shadow.md](docs/cloud-shadow.md)):
- **Ashburn, VA:** the region's air warmed **+0.71 °C/decade** (MERRA-2, p = 0.001), and the data-center area's **night-time surface heat** warmed a further **+0.25 °C/decade** beyond its surroundings (p = 0.001).
- **Memphis, TN:** greenness fell at xAI Colossus 1 (p < 0.001) and Colossus 2 (p = 0.047); NO₂ near Colossus 1 rose after the mid-2024 turbines, but the change is **borderline** (p = 0.051).
- Particle haze (aerosol optical depth): no significant increase at any site.

### Run it
| Command | Purpose |
|---|---|
| `npm run web` | Web explorer + JSON API on http://localhost:8765 |
| `npm run web:build` / `web:preview` | Static build in `dist/web/` (what GitHub Pages serves) / preview on :8080 |
| `npm run data:nasa` / `data:weather` / `data:timeline-imagery` / `data:unreal` | Refresh NASA series / NASA POWER weather / yearly 30 m imagery / timeline + Unreal exports (Python + `pip install pillow`) |
| `npm start`, `npm run check` | Environmental Node API on :3000 / backend checks after `npm run data:setup` (CI) |

The web explorer's committed case-study datasets do not yet cover water quality, groundwater, soil and agriculture indicators. The Node backend below adds separate station water-quality, modeled soil/water and agricultural climate-exposure data; these caches are not yet connected to the web explorer. Groundwater-specific products and calibrated crop-impact models remain future work.

### 1. Data and backend

Our part supplies the environmental evidence and the Node.js gateway used by the analysis engine and Unreal client. Coverage is global where sources support it, with acquisition focused on **Canada and the USA**, recent records and available historical inventories. Agriculture is included; social, demographic and electricity-bill forecasting are outside our scope.

**Implementation status:** this backend PR includes the expanded Node environmental API alongside the existing web explorer, NASA pipeline, statistical methods and Unreal work. Downloaded source caches, run results and verification receipts remain local and are not shipped. The existing web datasets and the Node API caches are separate; no automatic bridge between them is implemented.

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

**API behavior change:** `npm start` now serves environmental `/v1` operations, and `npm run demo` reads cached POWER series, requiring `data:sync` first. Old scenario request bodies are rejected; the accounting worker/schemas remain regression fixtures, with no economic outputs in the public environmental API. The web explorer still uses `npm run web` on port 8765 and its own `/api` contract. Give the two services distinct `PORT` values; browser integration still needs a proxy/CORS implementation.

**Still needed in this Node API:** trend/significance job integration, verified facility matching, calibrated facility-impact and agricultural models, and noise propagation/prediction. Ground noise and vegetation records can be imported with provenance, but no noise dataset or numeric NDVI observations were acquired; the public ORNL vegetation service was unavailable during setup.

See **[1. Data and backend — technical handoff](docs/data-and-backend.md)** for setup prerequisites, exact request/result examples, data locations, source limits and the extension points Part 2 should use.
