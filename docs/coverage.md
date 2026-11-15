# What you can explore where

Short answer: **the full, detailed experience exists only for the five case-study sites.** Everywhere else on Earth you get a lighter, live analysis. The app is not yet a tool for flying anywhere in the world and seeing every environmental issue at that spot.

The reason is cost, not code. Each detailed site needs prepared data: yearly 30 m imagery, a site-versus-surroundings time series for every variable, a timeline export, a wind-field box and a sourced fact ledger. That data is produced ahead of time by `npm run data:*` for the five sites listed in `data/cloudshadow/sites.json`.

## Feature availability

| Feature | 5 case-study sites (Colossus 1 & 2, Ashburn, Abilene, The Dalles) | Anywhere else (click on the globe) |
| --- | --- | --- |
| NASA map overlays (GIBS: NO₂, land-surface heat, greenness, aerosol, night lights) | Yes | Yes, global tiles |
| Trend chart + Mann-Kendall / Sen's slope / before-after t-test | Yes, precomputed (instant) | Yes, **live**: sampled from GIBS tiles in ~30 s, with a thinned record |
| Timeline slider 2003 → 2035 with yearly 30 m HLS ground imagery | Yes | No |
| 3D effects (impact ring, heat dome, embers, turbine plume, clouds/rain, server-hall massing) | Yes | No |
| Fluid weather sim around the site | Yes (32 km box) | No |
| Real-wind particle trails, NASA GEOS-FP (2018+) | **Detailed box** (±3° × ±4°, ~25 km cells) | **Global layer only** (2° × 2.5°), visible when zoomed out above ~2,500 km |
| Analysed wind at the site point (drives fluid, clouds, streaks) | Yes | No |
| Giovanni series (rainfall, soil moisture, evapotranspiration, groundwater, OMI NO₂) | Downloaded for the 5 sites (`data/raw/giovanni/`, not yet shown in the app) | Possible on request with `python -m services.models.trends.giovanni` after adding a site |
| Climate projections to 2100 (NEX-GDDP-CMIP6, 5 models, 2 SSPs) | Precomputed (`data/cloudshadow/projections/`) | API job `climate-projection` for any point (~1-5 min) |
| Air-dispersion screening (plume χ/Q on GEOS-FP winds) | Colossus 1 precomputed; any site via API | API job `plume-scenario` for any point (pulls GEOS-FP wind on demand) |
| Sourced facts ledger, story, guided tour | Yes | No |
| Node `/v1` backend caches (facilities, emissions inventories, water-quality stations) | Partly; not yet connected to the web app | Data is global/North America but not connected to the web app |

## Why not everywhere yet

- **Pipeline:** adding a site means running the NASA, weather, imagery, flow-field and Giovanni builds for it (`docs/flow-fields.md`, `apps/web/README.md` §4). The yearly imagery step alone takes ~10 minutes per site.
- **Resolution:** most NASA products are 1–25 km per pixel, or about 300 km for GRACE groundwater. They can show regional change anywhere. They cannot isolate a single building, so "issues affecting this exact location" always needs a comparison area and local records.
- **Attribution:** a trend near a facility is evidence to investigate, not proof the facility caused it. That holds equally for the five sites and for live clicks.

## Path to "anywhere"

1. **On-demand site build:** a backend job that accepts a lat/lon, runs the site pipelines (series, flow-field box, Giovanni), and caches the result. The Node `/v1` job system in `apps/api/` is the natural host.
2. **Global layers first:** extend the global GEOS-FP layer and GIBS overlays so every place gets regional context with no build step.
3. **Live mode parity:** show the analysed wind and Giovanni water series in live mode, clearly labelled as regional.

Tracked in [issue #4](https://github.com/Moustafa-FD/NasaSpaceHacks2026GoofyGoobers/issues/4) (UI, layers, wind/fluid, water).
