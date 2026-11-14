# Footprint Atlas web app: team guide

**This is the project judges will open** (NASA Space Apps 2026, *Be An Earth System Trend Detective!*). A 3D globe (CesiumJS) where you pick a data center, drag a **timeline slider from 2003 to 2035**, and compare NASA environmental records with trend statistics and p-values. Close-up neighborhoods add OpenStreetMap layouts, Copernicus reference elevation and illustrative low-poly architecture/vegetation. Andres is making the cinematic Unreal video separately; this app is the clickable product.

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
| `/?debug=1` | Logs annual-trend/particle state to the console after 8 s |
| `/?tour=0` | Start the guided tour |
| `/dev/fluid.html` | **Fluid playground**: tune the weather sim with sliders, no globe |

Keys: `[` / `]` previous / next year. ▶ plays through the years and orbits the camera.

### Low-poly neighborhoods and landscape

Zoom below approximately 5.8 km camera altitude near any of the five study sites, or choose **Campus ↗**, **Homes ↗** or **Fields ↗**. The app generates a neighborhood from cached OpenStreetMap footprints, streets, farmland, forests and water. **Campus** targets a source-tagged data-center building, **Homes** a mapped residential cluster, and **Fields** mapped crops/forest; **Globe** zooms back out. Auto switches back above 7.6 km to avoid flicker. `?site=colossus1&view=3d` opens the campus directly; add `&focus=fields` to enter the landscape.

The original **81-model kit** includes pitched/hip/dormer-roof homes with garages and porches, apartments, shops, barns, offices and warehouses, plus eight dedicated data-center assets. Server halls have industrial loading doors, corrugated walls, broad parapet roofs, rooftop chillers/fans, backup generators and electrical/service yards, rather than residential window grids. The planner selects data-center architecture from explicit OSM data-center class tags or supported campus name tags and footprint-size checks; proximity alone does not turn a house or unrelated warehouse into a data center. OSM tags are contributed labels, not independent facility verification or a complete census. Architectural families, cooling equipment and yard details remain illustrative, even when a footprint/name is mapped. The standalone substation/generator-yard assets are marked as infrastructure and excluded from the primary-hall chooser.

The selected campus pin anchors to the **mapped building's rendered roof**, with its precise geographic position transformed from the scene's local coordinates. Its local label identifies the source facility, such as **NTT VA9 · Data Center Alley**, without assigning regional MW to that building. After a site is prepared, its pin retains the campus latitude/longitude when zooming out and returns to ground clamping; unvisited sites initially use their study-area anchors. Globe labels retain explicitly scoped reported/planned capacity, including Ashburn's **5,000 MW region-wide**. Comparison rings keep their original study centers and hide locally along with unrelated pins. The place-card marker caption exposes the source feature and coordinates; roof altitude follows the illustrative building height/reference terrain, not a surveyed roof measurement.

Forests use repeated **nine-crown groves** as well as individual trees; mapped farmland receives **25-stem wheat patches**, and appropriate grass/park/residential land receives 3D meadow tufts. Placement is bounded and checks land cover, holes, roads, water and building occupancy. Scene statistics distinguish instanced clusters from their internal crowns/stems; the dock reports tree crowns. Feature-seeded model/color choices stay stable when zooming, changing sites and scrubbing the timeline.

The ground is a continuous, irregular faceted mesh with softly blended per-vertex land-cover colors. Close-up facets use approximately **55 m display spacing**; the overview uses approximately **110 m**. Their reference elevation is only a **17 × 17 grid at 412.5 m sample spacing** across the 6.6 km scene, fetched from the Copernicus GLO-90 source through Open-Meteo (90 m native source resolution). Bilinear interpolation and smaller display facets create smoother visuals, not new measured terrain detail. Water uses separately triangulated mapped polygons, with inner holes/islands retained and land cut away underneath; this avoids blue square ground tiles. Shore geometry uses bounded simplification for display, and failed water triangulations are skipped rather than filled across holes. Water aligns to the display DEM by default; it is not a measured flood surface or water-volume model.

Mapped OSM ways form **continuous road surfaces** that retain bends and shared junctions, with batched asphalt, paths, curbs, sidewalks and markings. Roads sample the actual rendered terrain facets; their resampled surface heights also keep cars on the asphalt. Missing road widths and all decorative street styling are illustrative. Proposed/construction ways are skipped, and the mesh creates no invented roads or parking lots.

The current map layout stays fixed across timeline years. Architectural details, missing building heights, garden planting and limited residential infill are illustrative; wheat is a visual crop style, not a surveyed crop classification. NDVI controls illustrative vegetation color, growth and canopy thinning, not actual crop yield or proof of individual tree mortality. Missing NDVI leaves scenery neutral. Baseline terrain comes from the sampled Copernicus reference DEM; it is not historical terrain. **Landscape & map details → Terrain evolution scenario** explicitly enables artistic mountain/valley and shoreline changes toward 2035; these are not geological or hydrological forecasts.

Close-up campus particles appear only for sites explicitly marked as documented combustion sources, after their onset year. Their drift uses available wind input; their emission rate and illustrative yard-edge source positions do not encode measured emissions or turbine locations. The dock retains the caption **“Illustrative combustion plume; not measured visible smoke.”** Ordinary data centers, roof chillers and cooling fans do not automatically emit smoke. Campus effects are removed when the site model is released.

**City activity** uses a bounded pool of **80 / 140 / 220 vehicles** in Low / Balanced / High graphics. About one fifth supports the foreground; the rest spreads across road cells and directions over roughly 2.4 km. Sedans, vans, buses and delivery trucks use authored metre dimensions, without minimum-pixel enlargement. Nearby vehicles use one color-baked mesh primitive each; distant traffic switches to small points. Prop, regional and cargo aircraft have distinct silhouettes. Current motion follows individual mapped polylines and wraps at their endpoints; connected intersection routing and traffic headways remain follow-up work. People, traffic and flights are illustrative, not live observations. The shared motion control pauses movement.

**Urban detail** combines contributed OSM parking lots, paved surfaces, crossings, and airport runways/taxiways/aprons where mapped within the local scene. Nearby data-center halls share one illustrative campus pad and perimeter, with public roads, water and known operator differences preventing merges. Close views add bounded garden fences, parking stripes, parked vehicles, entrance details and sixteen additional commercial/civic/transport architectural variants. Those details are not cadastral property boundaries or surveyed replicas. Broad airport boundaries are not paved; only mapped operational surfaces are rendered. All five supplemental snapshots include provenance and query scope.

**Local atmosphere** retains small procedural-noise cloud clumps with transparent gaps; clouds fade near the camera and below 400 m above ground. Distance haze is limited to 35%, with a separate stronger fade at the far scene boundary that preserves the nearest 300 m. Native fog is temporarily disabled locally to prevent stacking. Globe effects use subtle blue-gray wind/moisture fields and qualified combustion wisps; the orange heat dome and floating embers have been removed. Heat remains in the HUD, map layer and charts. Haze and smoke density do not measure pollutant concentrations.

**Motion speed** controls wind/weather movement and timeline playback together. It defaults to 0.35×; zero pauses motion. Actual wind speed labels retain their source units and values. Graphics default to adaptive quality; View options allow a manual override.

Generation runs in a Web Worker, reuses GPU-instanced meshes, caches two generated sites, and bounds buildings/tree clusters/crop patches/grass patches. Per-model material colors are baked into linear vertex colors so a model/palette group uses one draw primitive. Both close-up and overview geometry are generated: the overview substitutes much smaller building/tree silhouettes, retains detailed data-center architecture, omits wheat/grass detail and reduces tree instances. Camera-height hysteresis switches the active model near 1.5 km above the reference ground (0.9 km in low quality), rather than drawing both levels together. Fine detail returns when descending.

Site changes release both previous GPU models, shaders and local activity/atmosphere resources; close-up mode pauses the expensive distant weather solver and hides globe-only illustrative massing. Timeline landscape updates change shader uniforms without regenerating geometry. Only the selected site's map snapshot is loaded. Close-up lighting disables HDR/bloom for a readable material palette while retaining quality-controlled shadows. City-life, local-atmosphere and distance-LOD adapters are implemented locally; cross-browser appearance/performance tuning remains part of the release checklist, rather than a promised frame rate.

Reproduce assets/maps with `python scripts/build-low-poly-assets.py`, `python scripts/fetch-neighborhoods.py`, and `python scripts/fetch-terrain.py`. Add `--preview-png` to the asset builder for a depth-tested model contact sheet; asset generation uses only Python's standard library. Data acquisition is bounded and cached; zooming performs no new remote map acquisition. `npm run test:web` checks placement, budgets, determinism, glTF transforms, water polygon/terrain behavior and DEM/scenario behavior. See `data/cloudshadow/neighborhoods/README.md` for OSM/Copernicus/Open-Meteo provenance, attribution and limits, and `apps/web/assets/low-poly/README.md` for model dimensions, cluster counts and original-art provenance.

### Dedicated GPU on laptops

The globe and GPU fluid solver request WebGL's `high-performance` power preference. This is a hint; Windows and the browser select the adapter. Set Chrome to **High performance** in Windows **Settings → System → Display → Graphics**, then restart Chrome (a separate Chrome user-data directory also starts a fresh browser session without closing existing tabs).

Add `&gpu=1` to a view URL, for example `/?site=colossus1&year=2025&gpu=1`, to show the renderer name from the globe's actual WebGL context and its power preference. The diagnostic is local and sends no telemetry; browsers may withhold the GPU name. `quality=low` controls visual effects, independently of GPU selection.

## 2. What's on screen and where it comes from
| Visual | Meaning | Data | Code |
|---|---|---|---|
| **Ground imagery** changing by year | Real cloud-free NASA HLS 30 m image for that summer (2013–2026); future years reuse the latest image with a "projection" grade | `data/hls_timeline.json` | `timeline.js → setGround` |
| **Annual trend strip** (inside the timeline) | The site's annual signal: **site minus surroundings**, with a zero baseline. Observed values are solid, trend extensions dashed; provided 95% intervals are shaded. Missing years remain gaps. Click the strip to select a year. | `data/unreal/timeline/<site>.json` → `<VAR>_Local`, `_LocalLo/_LocalHi` | `timeline.js → renderTrendStrip` |
| **Site pins** | Selected local pin marks the mapped rendered roof and names the facility, without MW. Prepared sites retain exact campus coordinates in globe mode; regional/site capacity labels remain explicitly scoped. Unvisited pins start at study anchors. | Mapped campus footprint/name, reference terrain and display height; `sites.json → ledger.power.mw` | `site-marker.js`, `app.js`, `neighborhood.js → cs:campus-ready` |
| **Low-poly neighborhood** | Current mapped building/street layout with original architectural variants and stable illustrative colors. Data-center tags/names select industrial campus models; nearby homes remain homes. | `data/neighborhoods/<site>.json`, `assets/low-poly/manifest.json`, `kit.glb` | `neighborhood.js`, `neighborhood-core.js`, `neighborhood-worker.js` |
| **Faceted ground and polygon water** | Copernicus reference elevation with blended land-cover colors; mapped water is a separate mesh retaining islands/holes. Geometry/style are display approximations, not finer scientific evidence. | `data/neighborhoods/<site>.json`, `elevation-<site>.json` | `terrain-mesh.js`, `landscape.js`, `landscape-shader.js` |
| **Continuous streets** | Mapped ways retain bends/junctions and drape over the actual terrain facets. Missing widths, sidewalks and markings are illustrative. | Cached OSM road geometry and rendered ground triangles | `road-mesh.js`, `surface-height.js` |
| **Forest groves, wheat and meadow cover** | Dense modeled crowns/stems/tufts within mapped land cover. Yearly NDVI drives illustrative color/growth/thinning, not a crop census, yield estimate or individual mortality observation. | Mapped land cover, original cluster models, yearly NDVI display input | `neighborhood-core.js`, `landscape-shader.js` |
| **Cars, people, planes and street details** | Citywide car/van/bus/truck pool follows mapped polylines, capped at 80/140/220 vehicles by quality with distant point LOD. People, aircraft and street details are illustrative placements; none are live traffic/population/flight data. | Road surface paths/heights, camera, campus footprint and original activity models | `city-life.js`, `city-life-models.js` |
| **Local haze and clouds** | Camera-distance haze softens the scene edge; available wind/precipitation affect qualitative clouds. Neither haze nor cloud opacity measures pollution or cloud cover. | Camera/quality state and available yearly weather input | `local-atmosphere.js` |
| **Heat display** | Night heat remains in the HUD, heat layer and trend strip; no heat dome or floating embers. | `LST_Night_Local` | `timeline.js` |
| **Fluid weather field** (swirls on the ground, ~32 km) | Qualitative blue-gray wind/moisture wisps with transparent borders; no orange heat source. Combustion trace is gated to documented sources and does not scale with satellite NO₂ | `PlumeTowardDeg`, `WS10M`, `LST_Night_Local`, `NO2_Local`, `PrecipMMDay` | `fluid-gpu.js` (CPU fallback `fluid.js`), driven from `fx.js` |
| **Combustion plume** | Qualitative wind-driven particles only for explicitly documented combustion sites after onset. Close-up caption states “Illustrative combustion plume; not measured visible smoke.” Rate/particle density are not concentrations. | `sites.json → effects.plume`, onset and available yearly wind | `timeline.js` (globe), `campus-effects.js` (close-up) |
| **Wind-flow particle trails** (site box; whole globe when zoomed out) + HUD chip "GEOS-FP …" | Real gridded 10 m wind from NASA GEOS-FP analyses, 12 instants per year (2018+), time-lapsed. Also steers the fluid sim, clouds and streaks via `cs:wind`. Direction validated vs Dulles airport; speed relative | `data/fields/` (`npm run data:fields`), see [docs/flow-fields.md](../../docs/flow-fields.md) | `flowfield.js` |
| **Clouds, rain, wind streaks** | That year's NASA POWER wind and precipitation | `WS10M`, `PlumeTowardDeg`, `PrecipMMDay` | `fx.js`, `timeline.js` |
| **Sky tint** | Regional air-temperature anomaly that year | `T2M` | `fx.js → applyYear` |
| **Globe-only campus massing** | Legacy illustrative growth context after onset; hidden in close-up mode, where source footprints and detailed industrial models are used instead. | `sites.json → onset` | `fx.js → buildSite`, `neighborhood.js` |
| **Lighting** | Golden hour / night (VIIRS Black Marble city lights), HDR + bloom + shadows | – | `fx.js` |
| **Left panel** | Pick site + variable → chart, Mann-Kendall trend, before/after t-test, sourced ledger | `data/series/<site>.json`, `data/sites.json` | `app.js`, `stats.js` |

**Honesty rules (they protect our Validity score, so don't break them):**
- Numbers shown are measurements (or clearly labelled projections) with p-values. "Borderline" stays borderline (Memphis NO₂ p = 0.051).
- Effects (plume, fluid, architectural detail and vegetation growth/thinning) are **visualizations driven by data**, never presented as measured concentrations, biological outcomes or surveyed replicas.
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
├── js/site-marker.js   exact roof-marker validation, local facility names and scoped globe capacity labels
├── js/timeline.js      ES module: slider, yearly imagery, annual trend strip, qualified plume, wind streaks, HUD
├── js/fx.js            ES module: lighting/HDR/bloom/shadows, night lights, clouds, rain, sky tint,
│                       globe-only campus massing, orbit, adaptive quality; calls the fluid sim
├── js/neighborhood.js  zoom/site lifecycle, Campus/Homes/Fields controls, two-site CPU cache, scene/shader cleanup
├── js/neighborhood-core.js   deterministic placement, campus classification, bounded vegetation, instanced GLB assembly
├── js/neighborhood-worker.js worker-side asset-kit loading and off-main-thread scene generation
├── js/mesh-batching.js material-color baking into one primitive per model/palette, preserving flat normals
├── js/lod-mesh.js      small faceted distance substitutes; authored close-up models remain intact
├── js/terrain-mesh.js  continuous faceted terrain, vertex colors, polygon-water triangulation and ground subtraction
├── js/surface-height.js      samples the rendered terrain triangles for road/traffic alignment
├── js/road-mesh.js     continuous mapped road surfaces, junctions and resampled traffic-path heights
├── js/landscape.js     reference DEM sampling and explicitly illustrative landscape/vegetation helpers
├── js/landscape-shader.js    timeline uniforms for plant appearance and default-off terrain scenarios
├── js/campus-effects.js      documented-combustion policy and disposable close-up plume particles
├── js/city-life.js     connected-path lane motion, camera-near car pooling, activity budgets and cleanup
├── js/city-life-models.js    original tiny car/plane/lamp/sign model pack
├── js/local-atmosphere.js    finite-scene distance fog, qualitative clouds and proximity fading
├── js/motion.js        shared wind/weather/playback motion-speed setting
├── js/adaptive-quality.js    frame-time sampling, quality tiers and cooldowns
├── js/vendor/earcut.js polygon triangulation; upstream ISC license is retained alongside it
├── js/fluid-gpu.js     WebGL2 stable-fluids sim (60 fps) draped on the globe
├── js/fluid.js         CPU fallback sim
├── assets/low-poly/    original 81-model kit, individual GLBs, manifest, geometry templates and preview
├── dev/fluid.html      fluid playground
└── server.cjs          local dev server + JSON API (/api/sites, /api/analysis, /api/layers) used by Unreal
data/cloudshadow/       all data the app reads (served at /data/…): see data/README.md
scripts/                data pipeline (Python/Node) that produces data/cloudshadow
```
No bundler: plain ES modules + CDN Cesium 1.121 / Chart.js 4.4.1. Edit a file, refresh the page.

## 4. Common tasks
**Tweak a visual.** Effects are in `fx.js` (look for the `QUALITY` table and `applyYear`), the fluid look is in `fluid-gpu.js` (`CURL`, `DYE_DISSIPATION`, `display` shader colours). Use `/dev/fluid.html` for fluid.

**Tweak local scenery.** `scripts/build-low-poly-assets.py` authors the reusable models; `neighborhood-core.js` controls stable model selection, mapped-footprint placement and vegetation budgets. `terrain-mesh.js` controls terrain faceting, land-cover color blending and water geometry. `landscape-shader.js` controls timeline-driven appearance. Keep mapped source geometry and illustrative details distinct, and run `npm run test:web` after changes.

**Add a site.** Add an entry to `data/cloudshadow/sites.json` (copy an existing one: lat/lon, `onset`, story, `effects.ringVar`, `effects.plume`, ledger with sources). Then regenerate data (needs Python + `pip install pillow`):
```bash
npm run data:nasa                         # satellite series (~10 min first run; cached after)
npm run data:weather                      # NASA POWER weather
npm run data:timeline-imagery -- <siteId> # yearly 30 m images (slow, ~10 min per site)
npm run data:unreal                       # timeline + Unreal exports
```

**Add a variable to the trend strip / HUD.** It must exist in `data/unreal/timeline/<site>.json` (see `scripts/export_timeline.cjs → VARS`). Add it to `TREND_VARS` in `timeline.js`, and a `chip(...)` in `renderHud`. The legacy `effects.ringVar` site field selects the initial trend measurement.

**Add a guided-tour step.** `TOUR` array in `app.js`. Each step can call `window.CloudShadowTimeline.setYear(y)` to drive the slider.

**Optional streamed globe buildings.** The local low-poly neighborhoods work without a Cesium ion token. `setIonToken("<your Cesium ion token>")` in the browser console optionally adds streamed world terrain/OSM buildings to the globe; it is independent of the generated local kit. Never commit a token.

## 5. Deploy (public link for judges)
- `npm run web:build` → `dist/web/` (static, ~1.2 MB, no server needed). `npm run web:preview` serves it on :8080.
- **GitHub Pages (one-time setup by someone with admin/workflow rights):**
  1. Activate the workflow: copy `docs/deploy/pages.yml` to `.github/workflows/pages.yml`. Easiest on github.com: *Add file → Create new file* → name `.github/workflows/pages.yml` → paste → commit to `main`. (Pushing workflow files from a local clone needs a token with the `workflow` scope: `gh auth refresh -s workflow`.)
  2. *Settings → Pages → Source: GitHub Actions*.
  3. Every push to `main` then deploys to `https://moustafa-fd.github.io/NasaSpaceHacks2026GoofyGoobers/`.
- Put that URL in the Space Apps project submission.

## 6. To-do board (pick one, tell the team)
**Must (before submission)**
- [ ] Profile the final scene in target Chrome/Edge/Firefox sessions on real GPUs: changing imagery, annual trend strip, campus/homes/fields, city activity, local fog and close/overview transitions. Record measured frame times before claiming a frame-rate target; headless checks do not establish real-GPU visual quality.
- [ ] Merge to `main` → enable Pages → check the public URL works.
- [ ] Guided tour: add timeline steps (e.g. Colossus 2 2015 → 2026 → 2032; Ashburn night-heat trend) using `CloudShadowTimeline.setYear`.
- [ ] Mobile/small screens: timeline bar wraps; check nothing overlaps.

**Should**
- [ ] Check nearby location-label overlaps when zooming out.
- [ ] Timeline legend popover: "what am I looking at?" (one line per visual, from the table above).
- [ ] Crossfade the NASA data layer (top-bar "Map layer") between years like the ground imagery.
- [ ] Performance: tune the implemented adaptive-quality cooldowns, detailed/overview thresholds and local activity budgets against measured frame times on slower laptops.

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
