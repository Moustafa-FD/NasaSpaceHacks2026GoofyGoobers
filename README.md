
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
| **Scenario starter** | Node API + Python worker scaffold for future modeled scenarios (illustrative only) | `apps/api/`, `services/models/`, `packages/contracts/` |

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
| `npm start`, `npm run check` | Scenario API on :3000 / all checks (CI) |

Not yet covered with data: water quality, groundwater, soil and agriculture indicators. These are good next adapters (e.g. NASA SMAP soil moisture, GRACE-FO groundwater, crop-condition NDVI).
