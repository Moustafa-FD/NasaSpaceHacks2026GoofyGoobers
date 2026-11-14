# Claude Code handoff: Goofy Goobers, NASA Space Apps 2026

@AGENTS.md

## Who / when
- Team **Goofy Goobers**, NASA Space Apps Toronto (Centennial College, Downsview). Hackathon **Nov 14–15, 2026**; submission deadline **Sun Nov 15, 11:59 pm local**.
- Challenge: **Be An Earth System Trend Detective!** (pick NASA variables → time series → trend + significance: Mann-Kendall / t-test / CIs).
- Demo for judges: **7 slides max or a 30-second video** (English, or English subtitles). Judging = Impact, Creativity, Validity, Relevance (NASA data must be core), Presentation. Target awards: Art & Technology, Best Storytelling, Best Use of Data.

## The project: "Cloud Shadow"
The environmental footprint of AI data centers, measured with NASA data and shown in a cinematic 3D globe. Lead story: **xAI Colossus, South Memphis** (on-site methane gas turbines; Boxtown neighborhood ~3 km ESE). Other sites: xAI Colossus 2 (Memphis), Data Center Alley (Ashburn VA), Stargate Abilene TX, Google The Dalles OR.

## Decisions already made (don't relitigate)
- **Unreal Engine is the product and the demo** (team decision, Nov 14). Core interaction = a **timeline slider (past → present → future)** per site; flashy, cinematic, data-driven: Niagara Fluids plumes, heat shimmer, volumetric weather. The web app (`apps/web`) stays as the **analysis backend/API** and a fallback, not the showcase.
- **Focus = weather/heat + air pollution.** Jobs, taxes and bills were deliberately dropped from our part (no NASA data → weak "Relevance"). The teammate scaffold keeps those domains as *unavailable*; leave that alone.
- **Honest numbers, flashy visuals.** Any number on screen comes from `data/cloudshadow/` with its p-value; borderline stays "borderline". Fluid sims and effects are *visualizations* driven by data (direction, relative intensity); never present them as measured concentrations. Satellite change near a facility = evidence, not proof of attribution.
- MERRA-2 / NASA POWER regional weather is the **climate control**: a site signal must beat the regional trend.

## Results to feature (all in `data/cloudshadow/unreal/CloudShadowSites.csv`)
| Site | Finding | p |
|---|---|---|
| Ashburn | Region air +0.71 °C/decade; site **night surface heat +0.25 °C/decade beyond surroundings** | 0.001 / 0.001 ← headline |
| Colossus 1 | NO₂ +0.24×10¹⁵ molec/cm² vs. surroundings after mid-2024 | 0.051 **borderline** |
| Colossus 1 / 2 | Greenness −0.07 / −0.12 NDVI | <0.001 / 0.047 |
| All sites | Particle haze (AOD): no significant increase | n.s. |
| Wind (NASA POWER) | Memphis prevailing wind from SSW (192°) → plume drifts **north** (12°), 3.9 m/s. Boxtown (ESE) gets it on westerly-wind days. | climatology |

## Where things are
| Part | Path | Run |
|---|---|---|
| Unreal project (UE 5.8.3, Cesium 2.31) | `clients/unreal/CloudShadow/` | guide: `clients/unreal/CLOUDSHADOW_SETUP.md` |
| Level builder (Python, editor menu **Cloud Shadow**) | `clients/unreal/CloudShadow/Content/Python/cloudshadow_setup.py` | menu → Build / Refresh sites |
| Data for Unreal | `data/cloudshadow/unreal/` (`CloudShadowSites.csv/json`, `series/<site>_<var>.csv` yearly, `weather/<site>_monthly.csv`) | `npm run data:unreal` |
| NASA satellite adapter (GIBS tiles → values) | `scripts/precompute.py` → `data/cloudshadow/series/` | `npm run data:nasa` (`pip install pillow`) |
| NASA POWER weather (wind, T, rain, RH) | `scripts/fetch_weather.py` → `data/cloudshadow/weather/` | `npm run data:weather` |
| Yearly cloud-free 30 m imagery (HLS) | `scripts/hls_timeline.py` → `data/cloudshadow/hls_timeline.json` | `npm run data:timeline-imagery` (slow; parallelize per site with `--out=`) |
| Timeline export (past/present/projected rows) | `scripts/export_timeline.cjs` → `data/cloudshadow/unreal/timeline/` | part of `npm run data:unreal` |
| Stats (Mann-Kendall, Sen, Welch, de-seasoning; checked vs SciPy) | `apps/web/js/stats.js` | |
| Analysis API + web fallback, port 8765 | `apps/web/server.cjs` (`/api/sites`, `/api/analysis?site=&var=`, `/api/layers/<var>?date=`) | `npm run web` |
| Teammate scaffold (scenario API :3000, Python worker, contracts) | `apps/api/`, `services/models/`, `packages/contracts/` | `npm start`; `npm run check` must stay green |

Root `package.json` is `"type": "module"`, so our Node files are `.cjs`.

## Unreal status (as of Nov 14, ~2 pm, macOS)
- Plugins enabled: CesiumForUnreal (required), Python, EditorScriptingUtilities, HttpBlueprint, JsonBlueprintUtilities, WebBrowserWidget, **NiagaraFluids (beta), NiagaraSimCaching, MovieRenderPipeline, SequencerScripting, Text3D**.
- Level `/Game/CloudShadow/Maps/CloudShadow` is **built and committed** (builder verified twice in UE 5.8.3, incl. a clean-copy test): CesiumGeoreference on Colossus 1; Cesium World Terrain + Bing (**Overlay0**); **70 yearly NASA HLS 30 m imagery overlays `HLS_<site>_<year>` (2013–2026, all 5 sites) on Overlay1**; 8 NASA data overlays on **Overlay2** (`NASA_NO2_2025` active, `NASA_NO2_2023`, `NASA_HeatDay_2025`, `NASA_HeatNight_2025`, `NASA_NDVI_2025`, `NASA_LandDisturbance_2025`, `NASA_NightLights`, `NASA_Aerosol_2025`); hidden Google Photorealistic 3D Tiles; CesiumSunSky; DynamicPawn; 5 emissive pillars (height = MW) + labels + Boxtown marker. Saved showing Colossus 1, year 2025. Everything the script spawns is tagged `CloudShadow`; re-running replaces it.
- `set_year()` verified: 2016 → `HLS_colossus1_2016` + NO₂ active; 2030 → latest image (2026), logged as PROJECTED.
- **Not yet verified on screen**: terrain/overlay rendering. Each person must **Window → Cesium → Connect to Cesium ion** on their own machine. The token lives in `Content/CesiumSettings/`, which is git-ignored on purpose. Never commit it.
- `.uasset`/`.umap` go through **Git LFS**.

## Windows laptop setup (the team's 3D machine)
1. Install Git + **Git LFS**, run `git lfs install` **before** cloning/pulling (else `.umap`/`.uasset` arrive as pointer text). Branch: `Andres-Unreal-Engine`.
2. Epic Launcher → Unreal Engine **5.8**; Fab → **Cesium for Unreal → Install to Engine 5.8** (before opening the project). Blueprint/Python-only project: Visual Studio not required.
3. Node.js 24+, Python 3.11+ on PATH as `python`; `npm ci`.
4. Open `clients/unreal/CloudShadow/CloudShadow.uproject` → connect Cesium ion → open level `CloudShadow` → Play. First open compiles shaders (Niagara Fluids adds some); be patient.
5. If the globe is blank: check the ion connection, then select *Cesium World Terrain* → Details → *Refresh Tileset*.

## THE core feature: the timeline slider (past → present → future)
One slider per site. Dragging it changes **the ground, the data layers and the weather sim** together:

| Era | Ground (Overlay1) | Data layer (Overlay2) + numbers | Weather / fluid sim | Look |
|---|---|---|---|---|
| **Past** 2003–2025 | Real cloud-free 30 m NASA HLS image for that year, from 2013 (component `HLS_<site>_<year>`; before 2013 keep the 2013 image) | Observed annual values from `timeline/<site>.json` (`*_Site`, `*_Surround`) | NASA POWER wind/temp/rain for that year (`WS10M`, `PlumeTowardDeg`, `PrecipMMDay`, `T2M`) | Natural |
| **Present** (`Phase = present`, 2026; partial year, de-seasonalized) | Latest image | Latest values; NO₂ hero layer | Current-year weather (or recent climatology if POWER hasn't published it) | Natural, "NOW" marker |
| **Future** 2027–2035 (`Phase = projected`) | Latest image + clearly stylized "projection" grade (desaturate, holographic/scanline material, label **PROJECTED · IF THE TREND CONTINUES**) | `*_Site` = Sen's-slope trend line; `*_SiteLo/_SiteHi` = 95% CI band, **widens with time**: show it (e.g. heat-haze intensity range, ghosted bars) | Climatology of last 10 years | Stylized |

Rules: projection rows extend the measured trend, not a forecast; they follow the long-term trend line, so 2026→2027 can jump back toward the line. NO₂ (TROPOMI) has no projection (record too short); use NO2_OMI for long-term direction.

**Data files**: `data/cloudshadow/unreal/timeline/<site>.json` → `rows[]` (Year, Phase, `<VAR>_Site/_Surround/_SiteLo/_SiteHi` for LST_Night, LST_Day, NDVI, AOD, NO2_OMI, NO2, AirTemp; T2M, WS10M, PlumeTowardDeg, PrecipMMDay; ImageryLayer/Date/Url) and `projections{}` (slope/decade, 95% CI, p). Same as CSV next to it. `data/cloudshadow/hls_timeline.json` = yearly imagery per site.

**Editor helper (already works, Python)**: `cloudshadow_setup.set_year(site_id, year, data_layer=None)`, which activates `HLS_<site>_<shown year>` and optionally one `NASA_*` data layer. Menu **Cloud Shadow → Timeline: …** previews it. It's the reference logic for the runtime Blueprint.

## Build plan on Windows (in order; each step leaves something recordable)
**Time-box**: if terrain doesn't render by early afternoon Nov 15, record the web app tour (`npm run web`, ▶ Guided tour) as the fallback video.
1. **Open the level, connect Cesium ion, verify rendering.** Tune overlay blending (Overlay2 data over Overlay1 imagery over Overlay0 Bing) in the tileset material if needed.
2. **BP_TimelineController** (Actor in level): loads `timeline/<site>.json` (JsonBlueprintUtilities, or File → string → Json) on BeginPlay; `SetYear(int)` → (a) activate `HLS_<site>_<min(year,lastImageYear)>` on *Cesium World Terrain*, deactivate other `HLS_*`; (b) push row values to the FX below; (c) toggle the "PROJECTED" post-process/material when `Phase == projected`. Mirror `set_year()` in Python.
3. **WBP_Timeline** (UMG): big slider 2003→2035 with PAST / NOW / FUTURE zones, year readout, site selector, live numbers (value, trend/decade, p, CI) from the row; a "PROJECTED · IF TREND CONTINUES" badge in the future zone.
4. **Turbine plume, hero FX (Memphis)**: Niagara Fluids 3D gas (*Grid 3D Gas* smoke template) at Colossus 1. User params ← row: wind dir `PlumeTowardDeg`, wind speed `WS10M`, density ∝ `NO2_Site − NO2_Surround` (relative only; zero before the 2024 onset), tint by the NO₂ colormap (yellow→red). Cache with NiagaraSimCaching for renders.
5. **Weather volume**: UE Volumetric Cloud + wind-field particles / rain driven by `WS10M`, `PlumeTowardDeg`, `PrecipMMDay`, `T2M`.
6. **Heat (Ashburn, scientific headline)**: night lighting; heat-shimmer (refraction) intensity ∝ `LST_Night_Site − LST_Night_Surround`; data sculpture = one bar per year (`series/ashburn_LST_Night.csv`, `LocalAnomaly`, blue < 0 / orange > 0); **Text3D** "+0.25 °C/decade · p = 0.001 · NASA MODIS".
7. **Opening orbit**: activate `NASA_NightLights` (VIIRS Black Marble) for the space shot.
8. **Sequencer film (~30 s)**: orbit + night lights → dive to Memphis → scrub slider 2015→2026 (fields → Colossus, plume grows) → push into FUTURE (stylized, band widens) → Ashburn heat sculpture + numbers → pull back to all pillars → "Cloud Shadow · Data: NASA". Render with **Movie Render Queue** (1080p30), English captions.
9. Optional: live numbers from `npm run web` API (`/api/analysis?site=&var=`) via HttpBlueprint.

## Submission checklist
- ≤7 slides or the 30-s video; project page in English; GitHub link; **References** lists every external resource (NASA datasets, Cesium, Google 3D Tiles attribution, news sources in `data/cloudshadow/sites.json`).
- Submit on the Space Apps site before **Sun Nov 15, 11:59 pm**.
