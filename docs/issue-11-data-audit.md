# Issue #11 audit: layers, predictions and air performance

Audit of every category (Air, Vegetation, Heat, Water) for the 5 study sites, run on 2026-11-15 against the committed data. Re-run the coverage check with `node --test tests/issue11-consistency.test.js` (and `tests/environment-story.test.js`).

## What was wrong and what changed

| # | Finding | Cause | Fix |
| --- | --- | --- | --- |
| 1 | Panel **Air** showed "Unknown / Unknown" in large type | The app started on **TROPOMI NO₂** (record starts Sep 2023) in **3-year** mode. 2023 has only 4 months, so no 3-year window or pre-start baseline can ever exist before 2026 | Default Air is now **OMI NO₂ (2005–)**, the same dataset as the top **Air pollution** button. If a 3-year window can't be filled, the panel shows the selected year and says which years are short |
| 2 | Panel and map showed different NO₂ datasets | Panel default `NO2` (TROPOMI) vs map button `NO2_OMI` (OMI) | Same default (above); a **"Map: … / panel: …"** line states the map layer, its snapshot date, and the panel's averaging period |
| 3 | Map and panel periods looked inconsistent | The map is a single dated snapshot (e.g. 2025-07-15); the panel is a 3-year or annual average | Stated explicitly in the context line |
| 4 | Water kept a heat/air map underneath | No satellite water layer exists | Choosing **Water** returns the map to Satellite |
| 5 | Colossus 1 **aerosol (AOD)** was blank for every year | Real data gap: the site pixel has valid MODIS AOD in only 1–6 months/year (the nearby ring 11–12), likely river and bright industrial surfaces | Panel explains the coverage and offers the latest usable year instead of "Unknown" |
| 6 | **Vegetation** future views were empty after 2035 | The greenness trend extension stops at 2035; agriculture exposure needs a live external job (≤2049) | Every future year now shows the prepared NASA NEX-GDDP **growing-condition drivers** (temperature, very hot days, rainfall), labelled "not a vegetation or crop-yield prediction". The agriculture job remains available |
| 7 | **Air** calculation took ~1 minute | Clicked-point plume screening downloaded ~106 GEOS-FP wind frames, 4 at a time (measured **50.8 s**) | Points inside any prepared site wind box reuse the stored winds (**0.12 s**, within 0.12 m/s of the exact series); other points download with 12 parallel requests. Study-site plumes were already 2–3 s |
| 8 | Air results looked "unusually low" | χ/Q (s/m³) is a dilution factor and is always tiny (10⁻⁶–10⁻⁸); it isn't a concentration | Kept as χ/Q (no µg/m³ without a sourced emission rate, per the existing guard), plus a note and a **share-of-peak** column (e.g. Boxtown ≈ 0.3% of peak) |
| 9 | Water had no prepared observations | Giovanni downloads were unused | New committed `data/cloudshadow/water/<site>.json`: groundwater, topsoil moisture, rainfall and evapotranspiration, annual values plus an annual trend test. Shown in the Water tab |

Measured job timings (local, cold → cached): plume at a study site 2.9 s → 2.0 s; screening 3.3 s; CAMS air quality 2.2 s; plume at a clicked point 50.8 s → 0.12 s inside a prepared box.

## Coverage (prepared site series, 2025 view)

| Variable | All 5 sites | Notes |
| --- | --- | --- |
| NO₂ · OMI long record | ✅ 3-year + baseline | Default Air view |
| NO₂ · TROPOMI recent | One year only until 2026; no pre-start baseline at 4/5 sites | Record starts Sep 2023 |
| Aerosol (AOD) | ✅ except **Colossus 1** (site pixel 1–6 valid months/yr); The Dalles has gap years | Explained in panel |
| Greenness (NDVI) | ✅ | |
| Day / night surface heat | ✅ | |
| Regional air temperature | ✅ to 2025; 2026 has 8 months (needs 9) | MERRA-2 latency |
| Water (Giovanni) | ✅ groundwater 2003–2025, soil 2001–2025, rain 2001–2024 (2025 has 9 months), ET 2001–2025 | Regional, not facility use |

## What each category can predict

| Category | Years | Source | Kind |
| --- | --- | --- | --- |
| Air | 2027–2035 | OMI NO₂ trend extension (timeline rows) | "If the trend continues"; not a forecast |
| Air | any | Plume screening (GEOS-FP winds 2018–2026) | Conditional dilution footprint; concentration only with a sourced emission rate |
| Vegetation | 2027–2035 | NDVI trend extension | "If the trend continues" |
| Vegetation | 2027–2100 | NEX-GDDP climate drivers | Growing conditions, not greenness |
| Vegetation | ≤2049 | Agriculture exposure (live HighResMIP job) | Climate exposure, not yield |
| Heat | 2027–2035 / 2041–2060, 2081–2100 | Trend extension / NEX-GDDP (5 models, SSP2-4.5/5-8.5) | Regional climate scenario with model spread |
| Water | 2041–2060, 2081–2100 | NEX-GDDP rainfall | Rainfall only; groundwater, river level and quality are not predicted |

## Missing data points that would improve results

| Gap | Recommended source | Effect |
| --- | --- | --- |
| Colossus 1 aerosol site retrievals | **MODIS MAIAC MCD19A2** (1 km daily AOD; better coverage over bright/urban surfaces) | Usable site particle record at Colossus 1 |
| Ground-level NO₂/PM₂.₅ | **EPA AQS** monitors (Memphis, N. Virginia) | Calibrates satellite columns to breathing-level air |
| Emission rates for plume concentrations | Shelby County Health Dept. turbine permits; EPA NEI 2026+ | Turns χ/Q into a sourced µg/m³ |
| Facility water withdrawals | Utility/permit records (e.g. MLGW, Loudoun Water) | Separates facility use from regional groundwater change |
| Crop yields | USDA NASS county yields + Cropland Data Layer | Real agricultural outcomes beyond greenness |
| Higher-resolution land heat | Landsat 30 m surface temperature (ECOSTRESS 70 m) | Site-scale heat beyond 1 km MODIS |

Not added in this pass: these need new acquisitions or credentials (AQS key, permits). Everything shown keeps its evidence label; missing values stay missing.
