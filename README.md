
# Footprint Atlas

**Mapping the environmental footprint of our digital world.**

An environmental and agricultural trend explorer developed by **Team Goofy Goobers** for the **NASA Space Apps Challenge 2026**.

**Challenge:** [Be An Earth System Trend Detective!](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/)

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

### 1. Data and backend

Our part supplies the environmental evidence and the Node.js gateway used by the analysis engine and Unreal client. Coverage is global where sources support it, with acquisition focused on **Canada and the USA**, recent records and available historical inventories. Agriculture is included; social, demographic and electricity-bill forecasting are outside our scope.

**Implementation status — November 14, 2026:** the expanded backend is built and verified in the local implementation checkout, branch `codex/environment-data-backend`, commit `71d263d`. This documentation PR does not include that code or the downloaded data. The current `main` code remains the earlier illustrative starter; the operations below require the implementation checkout.

**Implemented locally:**

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

The local implementation passed **130 tests** and live verification of **17 acquisition/example jobs**. These checks verify acquisition and API behavior, not scientific causation or predictive accuracy. Regulatory sector candidates are not independently confirmed data centers, and the snapshots are not complete facility censuses.

**How Part 2 connects:** use the Node gateway to submit supported operations with `POST /v1/runs`, follow the returned HTTP status or WebSocket URL, and retrieve completed results. Browse cached locations and releases through `GET /v1/facilities` and `GET /v1/emissions`. Analysis code running in the backend can also use the typed adapters, cache and existing job executor in the implementation checkout. Keep reported emissions, environmental concentrations, measurements and climate scenarios distinct; facility identities are not automatically matched across sources.

**Still needed:** numerical trend/significance workers, verified facility matching, calibrated facility-impact and agricultural models, and noise propagation/prediction. Ground noise and vegetation records can be imported with provenance, but no noise dataset or numeric NDVI observations were acquired; the public ORNL vegetation service was unavailable during setup.

See **[1. Data and backend — technical handoff](docs/data-and-backend.md)** for setup prerequisites, exact request/result examples, data locations, source limits and the extension points Part 2 should use.
