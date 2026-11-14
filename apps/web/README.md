# Footprint Atlas web app: team guide

**This is the project judges will open** (NASA Space Apps 2026, *Be An Earth System Trend Detective!*). A 3D globe (CesiumJS) where you pick a data center, drag a **timeline slider from 2003 to 2035**, and watch the ground, heat, air pollution and weather around it change, all from NASA data, with trend statistics and p-values. Andres is making the cinematic Unreal video separately; this app is the clickable product.

> **Deadline: Sun Nov 15, 11:59 pm.** Prioritise: it works in a normal browser → it's deployed → it looks good → extras.

## 1. Run it (2 minutes)
```bash
git clone https://github.com/Moustafa-FD/NasaSpaceHacks2026GoofyGoobers.git
cd NasaSpaceHacks2026GoofyGoobers
git checkout Andres-Unreal-Engine   # or main once merged
npm run web                          # → http://localhost:8765   (Node 24+, no npm install needed for the web app)
```
Useful URLs while developing:
| URL | What |
|---|---|
| `/?site=ashburn&year=2031` | Open a site at a year (`colossus1`, `colossus2`, `ashburn`, `abilene`, `thedalles`) |
| `/?site=colossus1&year=2025&light=night` | Night lighting (NASA city lights) |
| `/?quality=low` | No HDR/bloom/shadows (slow laptops; also what headless Chrome needs) |
| `/?fluid=off` | Disable the fluid sim |
| `/?flow=off` | Disable the GEOS-FP wind-flow trails (fluid/clouds fall back to the annual NASA POWER wind) |
| `/?debug=1` | Logs ring/particle state to the console after 8 s |
| `/?tour=0` | Start the guided tour |
| `/dev/fluid.html` | **Fluid playground**: tune the weather sim with sliders, no globe |

Keys: `[` / `]` previous / next year. ▶ plays through the years and orbits the camera.

## 2. What's on screen and where it comes from
| Visual | Meaning | Data | Code |
|---|---|---|---|
| **Ground imagery** changing by year | Real cloud-free NASA HLS 30 m image for that summer (2013–2026); future years reuse the latest image with a "projection" grade | `data/hls_timeline.json` | `timeline.js → setGround` |
| **Impact ring** (bar per year around the site) | The site's signal: **site minus a surrounding ring**, for the chosen variable. Orange = worse, blue = better. Future = ghost bars + 95% CI label | `data/unreal/timeline/<site>.json` → `<VAR>_Local`, `_LocalLo/_LocalHi` | `timeline.js → buildEffects` |
| **Heat dome** + **embers** | Night-heat signal for that year | `LST_Night_Local` | `timeline.js`, `fx.js` |
| **Fluid weather field** (swirls on the ground, ~32 km) | GPU fluid sim: NASA POWER wind blows heat (orange), pollution (yellow, Colossus 1 turbines only, from 2024) and moisture (white) dyes | `PlumeTowardDeg`, `WS10M`, `LST_Night_Local`, `NO2_Local`, `PrecipMMDay` | `fluid-gpu.js` (CPU fallback `fluid.js`), driven from `fx.js` |
| **Wind-flow particle trails** (site box; whole globe when zoomed out) + HUD chip "GEOS-FP …" | Real gridded 10 m wind from NASA GEOS-FP analyses, 12 instants per year (2018+), time-lapsed. Also steers the fluid sim, clouds and streaks via `cs:wind`. Direction validated vs Dulles airport; speed relative | `data/fields/` (`npm run data:fields`), see [docs/flow-fields.md](../../docs/flow-fields.md) | `flowfield.js` |
| **Turbine plume** (3D smoke, Colossus 1) | On-site gas turbines from mid-2024, blowing with that year's wind | `NO2_Local`, wind | `timeline.js` |
| **Clouds, rain, wind streaks** | That year's NASA POWER wind and precipitation | `WS10M`, `PlumeTowardDeg`, `PrecipMMDay` | `fx.js`, `timeline.js` |
| **Sky tint** | Regional air-temperature anomaly that year | `T2M` | `fx.js → applyYear` |
| **Server-hall blocks** | *Illustrative* massing that appears after the site's start year (the imagery is the measured change) | `sites.json → onset` | `fx.js → buildSite` |
| **Lighting** | Golden hour / night (VIIRS Black Marble city lights), HDR + bloom + shadows | – | `fx.js` |
| **Left panel** | Pick site + variable → chart, Mann-Kendall trend, before/after t-test, sourced ledger | `data/series/<site>.json`, `data/sites.json` | `app.js`, `stats.js` |

**Honesty rules (they protect our Validity score, so don't break them):**
- Numbers shown are measurements (or clearly labelled projections) with p-values. "Borderline" stays borderline (Memphis NO₂ p = 0.051).
- Effects (plume, fluid, embers, blocks) are **visualizations driven by data**, never presented as measured concentrations.
- Future = "if the measured trend continues" (Sen's slope + 95% CI), not a forecast. Keep the PROJECTED badge.
- A change near a facility is evidence, not proof it caused it.
- Every reported number in `sites.json → ledger` has a source URL. New facts need one too.

## 3. Code map
```
apps/web/
├── index.html          page shell (panel, top bar, timeline bar); loads Cesium + Chart.js from CDN
├── css/style.css       all styles (CSS variables at the top; timeline styles at the bottom)
├── js/stats.js         Mann-Kendall, Sen's slope (+95% CI), de-seasoning, Welch t-test (checked vs SciPy). Also used by Node.
├── js/layers.js        NASA GIBS layer definitions (VARS), colormap decoding, live point sampler (click-anywhere)
├── js/app.js           globe setup, left panel, charts, ledger, map overlays/compare, guided tour.
│                       Exposes window.CloudShadow + fires "cs:ready" / "cs:site" events
├── js/timeline.js      ES module: slider, yearly imagery, impact ring, heat dome, plume, wind streaks, HUD
├── js/fx.js            ES module: lighting/HDR/bloom/shadows, night lights, clouds, rain, embers, sky tint,
│                       server-hall blocks, orbit, quality toggle; calls the fluid sim
├── js/fluid-gpu.js     WebGL2 stable-fluids sim (60 fps) draped on the globe
├── js/fluid.js         CPU fallback sim
├── dev/fluid.html      fluid playground
└── server.cjs          local dev server + JSON API (/api/sites, /api/analysis, /api/layers) used by Unreal
data/cloudshadow/       all data the app reads (served at /data/…): see data/README.md
scripts/                data pipeline (Python/Node) that produces data/cloudshadow
```
No bundler: plain ES modules + CDN Cesium 1.121 / Chart.js 4.4.1. Edit a file, refresh the page.

## 4. Common tasks
**Tweak a visual.** Effects are in `fx.js` (look for the `QUALITY` table and `applyYear`), the fluid look is in `fluid-gpu.js` (`CURL`, `DYE_DISSIPATION`, `display` shader colours). Use `/dev/fluid.html` for fluid.

**Add a site.** Add an entry to `data/cloudshadow/sites.json` (copy an existing one: lat/lon, `onset`, story, `effects.ringVar`, `effects.plume`, ledger with sources). Then regenerate data (needs Python + `pip install pillow`):
```bash
npm run data:nasa                         # satellite series (~10 min first run; cached after)
npm run data:weather                      # NASA POWER weather
npm run data:timeline-imagery -- <siteId> # yearly 30 m images (slow, ~10 min per site)
npm run data:unreal                       # timeline + Unreal exports
```

**Add a variable to the ring / HUD.** It must exist in `data/unreal/timeline/<site>.json` (see `scripts/export_timeline.cjs → VARS`). Add it to `RING_VARS` in `timeline.js`, and a `chip(...)` in `renderHud`.

**Add a guided-tour step.** `TOUR` array in `app.js`. Each step can call `window.CloudShadowTimeline.setYear(y)` to drive the slider.

**Optional 3D buildings.** In the browser console: `setIonToken("<your Cesium ion token>")` (free at ion.cesium.com). Adds world terrain + OSM buildings. Never commit a token.

## 5. Deploy (public link for judges)
- `npm run web:build` → `dist/web/` (static, ~1.2 MB, no server needed). `npm run web:preview` serves it on :8080.
- **GitHub Pages (one-time setup by someone with admin/workflow rights):**
  1. Activate the workflow: copy `docs/deploy/pages.yml` to `.github/workflows/pages.yml`. Easiest on github.com: *Add file → Create new file* → name `.github/workflows/pages.yml` → paste → commit to `main`. (Pushing workflow files from a local clone needs a token with the `workflow` scope: `gh auth refresh -s workflow`.)
  2. *Settings → Pages → Source: GitHub Actions*.
  3. Every push to `main` then deploys to `https://moustafa-fd.github.io/NasaSpaceHacks2026GoofyGoobers/`.
- Put that URL in the Space Apps project submission.

## 6. To-do board (pick one, tell the team)
**Must (before submission)**
- [ ] Open in a normal browser (Chrome/Edge/Firefox, real GPU) and check: ground imagery changes by year, fluid swirls, bars/plume/clouds render, 60 fps on HQ. *(Headless testing can't verify GPU visuals; nobody has seen them on a real GPU yet.)*
- [ ] Merge to `main` → enable Pages → check the public URL works.
- [ ] Guided tour: add timeline steps (e.g. Colossus 2 2015 → 2026 → 2032; Ashburn ring at night) using `CloudShadowTimeline.setYear`.
- [ ] Mobile/small screens: timeline bar wraps; check nothing overlaps.

**Should**
- [ ] Label overlaps (site label vs. ring year labels near north).
- [ ] Timeline legend popover: "what am I looking at?" (one line per visual, from the table above).
- [ ] Crossfade the NASA data layer (top-bar "Map layer") between years like the ground imagery.
- [ ] Performance: if a laptop struggles, start in LQ automatically (`fx.js → init`, e.g. based on `navigator.hardwareConcurrency` or measured fps).

**Could**
- [ ] Rain/clouds by month (NASA POWER monthly data is in `data/unreal/weather/<site>_monthly.csv`).
- [ ] Sound design (wind/hum) on Play.
- [ ] A "share this view" button (URL with site/year/light).

## 7. Gotchas
- Root `package.json` is `"type": "module"`, so Node scripts in this app are `.cjs`.
- `npm run check` (teammate scaffold: typecheck + API tests + Python tests) must stay green; CI runs it.
- Timeline rows: projected years follow the **trend line**, so 2026 → 2027 can jump back toward it. That's expected.
- TROPOMI NO₂ in GIBS only starts Sep 2023 (no projection); the 20-year record is OMI (`NO2_OMI`).
- Headless Chrome (CI/screenshots) renders HDR as black and loads 3D geometry inconsistently. Use `?quality=low` there.
