# ◐ Footprint Atlas: NASA trend findings & method
### The physical footprint of the digital cloud, seen from orbit.
**NASA Space Apps 2026 · Toronto (Centennial College, Downsview) · Team Goofy Goobers**
**Challenge:** *Be An Earth System Trend Detective!*

Every AI answer runs in a building that burns power, heats the ground and, when it runs its own gas turbines, pollutes the air its neighbors breathe. Cloud Shadow puts those buildings on a 3D globe and asks NASA's satellites a simple question:

> **Did the air and the heat around a data center change after it arrived, beyond what the regional weather explains, and is that change statistically real?**

| Step | What the tool does |
|---|---|
| 1. **Where?** | Pick a case study (xAI Colossus 1 & 2 in Memphis, Data Center Alley in Ashburn VA, Stargate Abilene TX, Google The Dalles OR) or **click anywhere on Earth**. |
| 2. **What?** | Choose a variable, each explained in plain language. **Pollution:** NO₂ (Sentinel-5P TROPOMI daily + Aura OMI 20-year record), particles/haze (MODIS aerosol optical depth). **Heat & weather:** land-surface temperature day/night (MODIS), regional air temperature (NASA MERRA-2) as the climate control. **Land:** greenness NDVI (MODIS). |
| 3. **Is it changing, and is it significant?** | Site vs. surrounding-ring time series, seasons removed, **Mann-Kendall trend test + Sen's slope**, and a **before/after Welch t-test** (autocorrelation-corrected, 95% CI) around the date the data center started. |
| 4. **Pollution & environment ledger** | Satellite results next to ground reports of emission sources (gas turbines), noise pollution and water use, every number sourced and labelled *reported / estimate / data gap*. |

### Headline findings (from the real NASA data in this repo)
| Site | What NASA data shows | Significance |
|---|---|---|
| **Data Center Alley, Ashburn VA** | Region's air is warming **+0.71 °C/decade** (MERRA-2), and the site's **night-time surface heat** rises a further **+0.25 °C/decade** faster than its surroundings: a 24/7 heat fingerprint on top of the regional climate | p = 0.001 ✓ / p = 0.001 ✓ |
| **xAI Colossus 1, Memphis** | **NO₂ +0.24 ×10¹⁵ molec/cm²** vs. surroundings since the gas turbines arrived (mid-2024) | p = 0.051, borderline |
| xAI Colossus 1, Memphis | Greenness −0.07 NDVI vs. surroundings | p < 0.001 ✓ |
| xAI Colossus 2, Memphis | Greenness −0.12 NDVI (land cleared 2025); NO₂ +0.42 | p = 0.047 ✓ / p = 0.15 (too few months yet) |
| Stargate Abilene TX | Greenness −0.20 NDVI since construction began | p = 0.06, borderline |
| All five sites | Particle haze (MODIS AOD): **no significant increase** | n.s. |

*Caveats we show in the app: pixels (1 km heat, ~5 km NO₂, 3 km aerosol) are bigger than most buildings; TROPOMI tiles in GIBS start Sep 2023, so Memphis has only ~9 "before" months; aerosol retrievals are sparse on the Memphis riverbank; a change after a start date is evidence, not proof of cause.*

---

## Run it

```bash
npm run web                # → http://localhost:8765  (web app + JSON API for Unreal)
```
No build step needed for the web app; the case-study data is already in `data/cloudshadow/`.

**Guided tour:** press **▶ Guided tour** (7 steps, ←/→ keys). That's the demo for judges.
**Your own spot:** click anywhere on the globe and the app pulls live NASA tiles (~30 s).

### Refresh / extend the data
```bash
pip install pillow
python3 scripts/precompute.py            # NASA GIBS → data/cloudshadow/series/*.json (~10 min first run, cached after)
python3 scripts/precompute.py --hls      # also pick cloud-free 30 m before/after dates
npm run data:unreal            # → data/cloudshadow/unreal/*.csv|json for Unreal
```
Add a site: append it to `data/cloudshadow/sites.json` (lat/lon/onset + ledger), then rerun the two scripts.

### API (for Unreal or anything else)
| Endpoint | Returns |
|---|---|
| `GET /api/sites` | all sites, results per variable, ledger, sources |
| `GET /api/analysis?site=colossus1&var=NO2` | full stats + yearly & monthly series |
| `GET /api/layers/NO2?date=2025-07-15` | Cesium-ready overlay URL template (date snapped to real data) |

## Unreal Engine
See **[clients/unreal/CLOUDSHADOW_SETUP.md](../clients/unreal/CLOUDSHADOW_SETUP.md)**. The project is in `clients/unreal/CloudShadow/`. It has a **Cloud Shadow → Build Cloud Shadow level** menu that builds the Cesium globe, NASA overlays and site pillars in one click.

## How it works
```
NASA GIBS (WMTS tiles, no login) ──► decode pixel colours with GIBS colormaps ──► physical values
        ──► site (3×3 px) vs ring (km) ──► monthly series ──► de-season ──► Mann-Kendall / Sen / Welch
```
- `scripts/precompute.py`: tile fetch + colormap decode + monthly aggregation (Python, Pillow)
- `apps/web/js/layers.js`: the same sampler in the browser (live mode)
- `apps/web/js/stats.js`: statistics (checked against SciPy)
- `scripts/summary.cjs` + `apps/web/server.cjs`: Node API; `scripts/export_unreal.cjs`: Unreal export
- `data/cloudshadow/sites.json`: case studies, stories and the sourced impact ledger

## Data & sources
NASA GIBS: MODIS/Terra LST (8-day) & NDVI (16-day) · Sentinel-5P TROPOMI NO₂ · Aura OMI NO₂ · HLS (Landsat 8/9 + Sentinel-2, 30 m) · OPERA DIST-ANN. Basemap: Esri World Imagery. 3D: CesiumJS / Cesium for Unreal.
Ledger sources are linked in-app (SELC, Inside Climate News, DCD, NPR, CNN, Mississippi Today, Mississippi Free Press, Virginia JLARC, Loudoun County, Texas Standard, OPB, EIA…).
