# Flow fields: one wind source for the web app and Unreal

Both front ends (the CesiumJS web app and the Unreal + Cesium film) read **the same files**, so particles, plumes, clouds and the fluid sim move with the same real wind.

## What the data is

| | |
| --- | --- |
| Source | **NASA GMAO GEOS-FP** assimilation, collection `inst3_2d_asm_Nx`, public OPeNDAP at `opendap.nccs.nasa.gov`, no login |
| Native grid | 0.25° lat × 0.3125° lon, every 3 h, 2017-12-01 to near real time |
| Variables | `u10m`, `v10m` (10 m east/north wind), `t2m` (2 m air temperature), `slp` (sea-level pressure) |
| Evidence class | `model_analysis`: a weather model combined with assimilated observations. It is the real large-scale flow at each frame time, **not** a measured pollutant concentration. |
| Products | **Global**: 2.0° × 2.5° grid, wind only. **Site**: native-resolution box ±3° lat × ±4° lon around each site, with wind, temperature and pressure, plus an exact wind series at the site point. |
| Frames | 12 per year (one instant per month), 2018 to the latest analysis. Hours rotate through 00, 09, 18, 03, 12, 21, 06, 15 Z, so no time of day dominates. |

Build or refresh (resumable; it stops when everything is complete or no newer analysis exists):

```bash
npm run data:fields
```

Options: `python -m services.models.fields.build --years 2024-2026 --sites ashburn --frames 12 --no-global`. The output goes to `data/cloudshadow/fields/`, which the web app serves at `data/fields/` and `npm run web:build` copies.

## Validation (Ashburn, 2025)

| Check | Result |
| --- | --- |
| Direction vs NOAA observations at Washington Dulles (KIAD, ~10 km away) | Median difference **~9°**; all 7 instants with a reported direction within 37° |
| Speed vs Dulles | GEOS-FP **1.98 m/s** vs **3.15 m/s** observed (8 instants, ~37% low). NASA POWER (MERRA-2) read ~18% high. A grid-cell average over suburbs and forest is calmer than an exposed airport anemometer. **Speed is shown as relative and is not corrected.** |
| 2 m temperature vs NASA POWER hourly | Mean absolute difference **1.3 K** (12 instants) |

The same summary is in `data/cloudshadow/fields/index.json → validation`.

## File format (`flow-field/1.0`)

Schema: [`packages/contracts/schemas/flow-field.schema.json`](../packages/contracts/schemas/flow-field.schema.json); TypeScript type: `FlowFieldManifest` in `packages/contracts/src/index.ts`.

```text
data/cloudshadow/fields/
  index.json                     list of products + validation summary
  global/<year>.json             manifest
  global/<year>.wind.png         RGB atlas: R = u, G = v, B = 255 valid / 0 missing
  <site>/<year>.json             manifest + siteSeries (exact u, v, speed, towardDeg, t2mK, slpHpa per frame)
  <site>/<year>.wind.png
  <site>/<year>.scalars.png      RGB atlas: R = t2m (200–330 K), G = slp (940–1060 hPa)
```

- **Atlas layout:** frames are tiles in row-major order (frame 0 top-left), `atlas.cols` tiles per row, each tile `grid.nx × grid.ny` pixels.
- **Rows run north → south** (image convention). Pixel row 0 of a tile is `grid.latMax`; column 0 is `grid.lonMin`. The global grid wraps in longitude.
- **Decoding:** `value = min + byte / 255 × (max − min)`. Wind uses −40…+40 m/s, a step of 0.31 m/s. Use `siteSeries` when you need exact values at the site.
- **Bearing convention:** `towardDeg` is where the air moves **toward** (0 = north, 90 = east). Meteorological "wind from" = `towardDeg + 180`.

## Web app (`apps/web/js/flowfield.js`)

- Loads `data/fields/index.json`, then the site and global products for the selected year (2018 onward; projected years have none).
- **Particle trails** follow the real gridded wind: the site box when zoomed in, the global field when the camera is above 2,500 km. They cycle through the year's frames (one every 2 s), are coloured by relative speed, and show where air moves; they are not concentrations.
- Fires `cs:wind` events (`towardDeg`, `speed`, `time`, `siteId`). `fx.js` (clouds and the GPU fluid sim via `setWind`) and `timeline.js` (wind streaks and plume drift) follow it, replacing the single annual NASA POWER arrow. Before 2018, and for projected years, the POWER values stay in use.
- HUD chip `#tlFlow` shows the current analysis time, direction arrow and speed. Disable with `?flow=off`.

## Unreal (`clients/unreal/CloudShadow`)

Use the same files. No engine-specific build step is needed:

1. **Plume and cloud direction (simplest):** read `<site>/<year>.json → siteSeries` (JsonBlueprintUtilities). In `BP_TimelineController`, step through the 12 rows, or interpolate between them over time, and drive the Niagara user parameters `WindTowardDeg = towardDeg` and `WindSpeed = speed`. This replaces the single `PlumeTowardDeg`/`WS10M` value per year.
2. **Spatial wind for Niagara Fluids / particles:** import `<site>/<year>.wind.png` as a texture with **sRGB off**, compression *VectorDisplacementmap (RGBA8)* and filter *Nearest*. In the Niagara module, compute the tile for the current frame (`col = f % cols`, `row = f / cols`), map the particle's lon/lat to UV inside that tile (v = 0 at `latMax`), sample R/G, and decode with the formula above. Feed the result as the wind/velocity force.
3. **Pressure/temperature looks:** `scalars.png` G channel → isobar lines (contour every 4 hPa) or volumetric-cloud density; R channel → heat-haze tint.

Keep the wording from CLAUDE.md: the flow is a NASA analysis (real winds); plumes driven by it remain visualizations.

## Water and pollution: what does and doesn't move with this field

- **Air** (NO₂, particles, heat plumes) moves with the wind, so these fields apply.
- **Water** pollution moves with rivers and groundwater, not wind. A water flow layer needs a hydrography network plus discharge, for example USGS NHDPlus flowlines with USGS gauge discharge, or GRACE/GLDAS for storage changes. None of these is built yet; until it is, water pollution is not animated.
- Measured pollution maps (TROPOMI/OMI NO₂, MODIS aerosol) stay as the colour layers they are. Particles show transport direction only, never concentration.

## Refresh policy

Use dated snapshots plus a bounded refresh; there is no perpetual loop (AGENTS.md). Re-running `npm run data:fields` fetches only what is missing (for example new months of the current year) and exits. During a live demo, a forecast layer could be refreshed every 6 h until the event ends. GEOS-FP also publishes 5-day forecasts (`/fp/0.25_deg/fcast/`), which can be added the same way.

## STRATA, WeatherNext 3 and why GEOS-FP is used now

| | STRATA | WeatherNext 3 (Google DeepMind) | GEOS-FP (used) |
| --- | --- | --- | --- |
| What | Km-scale AI emulator of one storm-resolving simulation | Operational AI forecast: 15-day, 64-member ensemble, hourly; surface 5–10 km, atmosphere 25 km | NASA operational analysis and forecast |
| Inputs needed | 145-channel SCREAM-format state, A100/H100 GPU, Linux | None (data products) | None |
| Access | Hugging Face weights | Data request form (Google says typically 5–7 business days); real-time data under experimental terms, history (≥1 h old) CC BY 4.0; WeatherNext 3 weights not open | Public, no login, tested |
| Horizon | Hours to days; biases grow | Up to 15 days | Analyses since Dec 2017 plus 5-day forecasts |
| NASA data (judging "Relevance") | No | No | **Yes** |
| Fit here | Poor | Strong future add-on for a probabilistic forecast layer | Best for the deadline |

WeatherNext 3 is a much better forecast tool than STRATA, but it would not arrive before the submission deadline. It also only covers the next two weeks, so it doesn't replace the historical NASA record the challenge is judged on. It is worth requesting access for a post-hackathon forecast layer that would use this same file format.
