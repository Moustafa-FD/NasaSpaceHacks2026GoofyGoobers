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
| `/?site=ashburn&view=3d&focus=shops` | Open mapped commercial detail; `focus=airport` opens a mapped airport when available |
| `/?fluid=off` | Disable the fluid sim |
| `/?debug=1` | Logs annual-trend/particle state to the console after 8 s |
| `/?tour=0` | Start the guided tour |
| `/dev/fluid.html` | **Fluid playground**: tune the weather sim with sliders, no globe |

Keys: `[` / `]` previous / next year. ▶ plays through the years and orbits the camera.

### Low-poly neighborhoods and landscape

Zoom below approximately 5.8 km camera altitude near any of the five study sites, or choose **Campus ↗**, **Homes ↗** or **Fields ↗**. The app generates a neighborhood from cached OpenStreetMap footprints, streets, farmland, forests and water. **Campus** targets a source-tagged data-center building, **Homes** a mapped residential cluster, and **Fields** mapped crops/forest. **Shops** and **Airport** appear when those mapped focus areas are available. These quick views return to the selected study site's retained base patch; **Globe** zooms back out. Auto switches back above 7.6 km to avoid flicker. `?site=colossus1&view=3d` opens the campus directly; add `&focus=fields`, `&focus=shops` or `&focus=airport` to choose another available view.

Bundled-site startup launches four JSON requests together: the map snapshot, reference elevation, urban supplement and recreation supplement. Generation then arrives in stages: a lightweight mapped preview with terrain, water, roads and coarse buildings; full neighborhood detail; and the optional distance overview separately. The preview uses a separate cheap mapped-only plan. The full property/vegetation plan is computed once and shared by detail and overview, so showing the first usable map does not wait for every garden, tree and distance model.

GPU upload starts during the approach below 12 km near the selected place. The scene stays hidden in globe mode until the existing low-poly threshold is reached, and manual Auto-off prevents warming. Preview roads retain mapped widths and bends while deferring curbs, sidewalks and paint. A failed detail upload keeps its working preview and is not retried on every camera event. `data-first-visible-ms`, `data-detail-visible-ms` and `data-load-stage` on the scene dock expose actual render-stage timing for local QA.

**Panning into a new area** below approximately 2.1 km above the reference ground requests real map/elevation data through the same-origin server. A request begins when the camera target moves about 1.15 km from the loaded patch center. The visible region follows the target as a circle with roughly 2.2–3.0 km radius and a 600 m feathered edge; a separate circular patch boundary softens the finite downloaded extent. Region upgrades and pan swaps retain existing scenery until the replacement reaches Cesium's GPU render-ready event, then use a two-second opaque dither crossfade. A worker result or parsed GLB alone is not render-ready. Current, retiring and uploading patches have explicit lifecycles; retired shaders, controllers and models are released.

Public OpenStreetMap/Overpass and Open-Meteo acquisition still depends on provider load, rate limits and queueing; staged rendering does not make uncached source data instant. The server serializes provider jobs and imposes a 180-second job deadline; the elevation adapter retains its request pacing. While waiting, the dock reports loading/preparing and keeps existing scenery. Missing or failed source coverage remains explicit; a source failure does not create a substitute town. Selected-site measurements, comparison centers and exact facility markers stay anchored when exploring another area. A streamed data center does not inherit the selected facility's documented combustion effect.

The client checks streaming at most once a second, runs one request/poll pipeline and keeps only the latest queued destination. Quantized **0.01°** keys allow reuse. CPU memory holds at most **two completed study-site scenes** and a separate **two-region streamed cache**, while the selected base scene supports quick views. There is no persistent generated-neighborhood GLB cache. Zooming out or changing sites aborts/ignores obsolete work. The server's bounded disk cache under ignored `tmp/streamed-neighborhoods/` stores source patch bundles (up to twelve), and its in-memory ready-result cache holds two; these are separate from compiled browser scenes. Provider failures cool down before another attempt. The dock's `data-stream-state`, `data-center`, `data-patch-count` and `data-gpu-models` attributes support local QA.

`scene-compiler.js` handles the worker's `preview`, `detail` and `complete` messages, forwards progressive results and ignores stale replies. The worker permits one active job and two queued jobs; newer requests supersede excess queued work. Cancellation removes queued jobs and is checked between build stages. An overview failure keeps an already usable detailed scene rather than discarding it. These are bounded loading/resource policies, not a guaranteed startup time or frame rate.

The development server exposes:

| Request | Response |
|---|---|
| `GET /api/neighborhood?lat=39.03&lon=-77.47` | `200 {status:"ready",snapshot,elevation,urban}` when a valid region is cached/acquired |
| Same request while queued/acquiring | `202 {status:"pending"\|"loading",retryAfterMs:2000,...}`; the client polls after the indicated delay |
| Unavailable source, pressure or cooldown | `503 {status:"failed",error,retryAfterMs,...}`; existing scenery stays available |

The endpoint validates numeric coordinates and currently supports latitudes **−75° to +75°**. It uses Python's existing map/elevation adapters; configure `DATA_PYTHON_EXECUTABLE` or `PYTHON` when the server should use a particular interpreter. It also reuses a sufficiently nearby original study snapshot with that snapshot's actual center intact. Dynamic pan acquisition requires this server/API; a static-only deployment retains the bundled study-site scenes.

The original **84-model kit** includes pitched/hip/dormer-roof homes with garages and porches, apartments, shops, barns, offices and warehouses, plus eight dedicated data-center assets. Server halls have industrial loading doors, corrugated walls, broad parapet roofs, rooftop chillers/fans, backup generators and electrical/service yards, rather than residential window grids. The planner selects data-center architecture from explicit OSM data-center class tags or supported campus name tags and footprint-size checks; proximity alone does not turn a house or unrelated warehouse into a data center. OSM tags are contributed labels, not independent facility verification or a complete census. Architectural families, cooling equipment and yard details remain illustrative, even when a footprint/name is mapped. The standalone substation/generator-yard assets are marked as infrastructure and excluded from the primary-hall chooser.

The selected campus pin anchors to the **mapped building's rendered roof**, with its precise geographic position transformed from the scene's local coordinates. Its local label identifies the source facility, such as **NTT VA9 · Data Center Alley**, without assigning regional MW to that building. After a site is prepared, its pin retains the campus latitude/longitude when zooming out and returns to ground clamping; unvisited sites initially use their study-area anchors. Globe labels retain explicitly scoped reported/planned capacity, including Ashburn's **5,000 MW region-wide**. Comparison rings keep their original study centers and hide locally along with unrelated pins. The place-card marker caption exposes the source feature and coordinates; roof altitude follows the illustrative building height/reference terrain, not a surveyed roof measurement.

Forests use repeated **nine-crown groves** as well as individual trees; mapped farmland receives **25-stem wheat patches**. Suitable green open ground receives a continuous procedural grass material instead of separate meadow-tuft meshes. Tree and crop placement is bounded and checks land cover, holes, roads, water and building occupancy. Scene statistics distinguish instanced clusters from their internal crowns/stems; the dock reports tree crowns. Feature-seeded model/color choices stay stable when zooming, changing sites and scrubbing the timeline.

The ground is a continuous, irregular faceted mesh with softly blended per-vertex land-cover colors. Natural tint boundaries use an irregular feathering kernel and smooth interpolation instead of straight color bands or square patches. This changes appearance only: mapped classifications and geometry remain intact, while shores and separately rendered paving stay sharp. Close-up facets use approximately **55 m display spacing**; the overview uses approximately **110 m**. Their reference elevation is only a **17 × 17 grid at 412.5 m sample spacing** across the 6.6 km scene, fetched from the Copernicus GLO-90 source through Open-Meteo (90 m native source resolution). Bilinear elevation interpolation and smaller display facets create smoother visuals, not new measured terrain detail. Water uses separately triangulated mapped polygons, with inner holes/islands retained and land cut away underneath. Shore geometry uses bounded simplification for display, and failed water triangulations are skipped rather than filled across holes. Water aligns to the display DEM by default; it is not a measured flood surface or water-volume model.

Mapped OSM ways form **continuous road surfaces** that retain bends and shared junctions, with batched asphalt, paths, curbs, sidewalks and markings. Roads sample the actual rendered terrain facets; their resampled surface heights also keep cars on the asphalt. Missing road widths and all decorative street styling are illustrative. Proposed/construction ways are skipped, and the mesh creates no invented roads or parking lots.

Street frontage is sampled cumulatively along mapped ways, including short source segments. The default scene allows up to 1,600 illustrative infill buildings (320,000 added triangles), separately from its mapped-building budget; streamed patches allow 1,200. Eight-sector and distance-band allocation spreads properties across the patch. Houses, apartments, shops and offices follow nearby land-use context and avoid roads, existing mapped footprints (including unrendered ones), water, fields, forests, parking and airport surfaces. Infill homes share the driveway and garden detailing pass, and shops receive small concrete pads. Backyards extend away from street frontage with three fence sides and a side gate. Their desired 12–20 m depth and width shrink around mapped buildings, neighboring yards, roads, water and recreation areas; they are illustrative gardens, not property boundaries. These additions are illustrative scenery, not surveyed buildings.

The current map layout stays fixed across timeline years. Architectural details, missing building heights, garden planting and street-front homes and businesses are illustrative; wheat is a visual crop style, not a surveyed crop classification. NDVI controls illustrative vegetation color, growth and canopy thinning, not actual crop yield or proof of individual tree mortality. Missing NDVI leaves scenery neutral. Baseline terrain comes from the sampled Copernicus reference DEM; it is not historical terrain. **Landscape & map details → Terrain evolution scenario** explicitly enables artistic mountain/valley and shoreline changes toward 2035; these are not geological or hydrological forecasts.

Close-up campus particles appear only for sites explicitly marked as documented combustion sources, after their onset year. Their drift uses available wind input; their emission rate and illustrative yard-edge source positions do not encode measured emissions or turbine locations. The dock retains the caption **“Illustrative combustion plume; not measured visible smoke.”** Ordinary data centers, roof chillers and cooling fans do not automatically emit smoke. Campus effects are removed when the site model is released.

**City activity** uses a bounded pool of up to **150 / 300 / 510 vehicles** in Low / Balanced / High graphics; small road networks can support fewer safely spaced vehicles. Cached road cells are selected by the actual camera frustum across the rendered patch. About 35% supports the foreground; the remaining pool spreads across visible cells, with extra weight for primary, secondary, trunk and motorway roads. Off-screen vehicles retarget when the camera turns or pans; visible vehicles stay on connected routes. Sedans, vans, buses, delivery trucks, rigid trucks and loaded flatbeds use authored metre dimensions at a consistent 0.76 display scale, without minimum-pixel enlargement. Visible vehicles with sufficient projected pixel size use one color-baked mesh primitive each, capped at 25/50/85 detailed models by graphics tier; the remaining traffic uses small points. Overview traffic is entirely point-based. Camera coverage is recomputed only after meaningful view changes. Parked cars use the same compact scale. A worker-built graph joins mapped ways at shared endpoints and compatible intersections, respecting available one-way/bridge metadata. Vehicles traverse those connections continuously, keep bumper spacing and reserve junction turns. Dead ends use smooth turns where the vehicle fits; an isolated one-way terminal stops visibly. Larger vehicles avoid narrow roads/turnarounds, and mapped driveways/parking aisles have slower illustrative speeds and vehicle limits. Off-screen recycling supports camera movement; visible cars do not wrap or fade at individual road ends. Prop, regional and cargo aircraft have distinct silhouettes. Traffic, people, speeds and flights are illustrative activity, **not real traffic measurements, demand forecasts or a traffic-engineering simulation**. The shared motion control pauses movement.

**Urban detail** combines contributed OSM parking lots, paved surfaces, crossings, and airport runways/taxiways/aprons where mapped within the local scene. Nearby data-center halls share one illustrative campus pad and perimeter, with public roads, water and known operator differences preventing merges. Close views add bounded garden fences, parking stripes, parked vehicles, entrance details and sixteen additional commercial/civic/transport architectural variants. Those details are not cadastral property boundaries or surveyed replicas. Broad airport boundaries are not paved; only mapped operational surfaces are rendered. All five supplemental snapshots include provenance and query scope.

**Local atmosphere** retains small procedural-noise cloud clumps with transparent gaps; clouds fade near the camera and below 400 m above ground. Distance haze is limited to 35%, with a separate stronger fade at the far scene boundary that preserves the nearest 300 m. Native fog is temporarily disabled locally to prevent stacking. Globe effects use subtle blue-gray wind/moisture fields and qualified combustion wisps; the orange heat dome and floating embers have been removed. Heat remains in the HUD, map layer and charts. Haze and smoke density do not measure pollutant concentrations.

Mapped recreation uses an additional OSM leisure/sport snapshot for all five bundled areas and optional streamed patches. Courts and fields retain mapped outlines and sports tags; original low-poly nets, hoops, goals, backstops, playground equipment, pavilions, picnic tables, benches and fitness bars add variety. Generic park furniture stays illustrative. Missing or ambiguous sport tags do not invent a sport. The complete layer is one color-baked draw batch with a reduced overview version; Parks opens a mapped nearby recreation feature.

Forest groves use irregular mixed crowns with varied heights and colors, matching organic layouts in the overview models. Tree placement uses independently mixed stable seeds and wider jitter, while mapped individual tree positions and road/water/building exclusions remain intact. Natural ground materials blend continuously from the existing ground color: green suggests grass, yellow/brown suggests dry turf or soil, pale warm tones suggest sand, and neutral gray suggests rock. These are artistic material cues, not new soil, geological or land-cover observations. World-anchored variation uses meter-scale structure, with fine blades/grains fading by projected pixel footprint while broad variation remains. The old square meadow meshes are no longer emitted; roads, paving, building faces, courts and water retain their own materials.

After its mapped preview, the worker shares one deterministic full property/vegetation plan across close and overview builds. Model buffers transfer as each stage becomes available. Generated GLBs omit unused source-kit meshes, materials and binary views. Exact Float32 vertex sharing preserves flat normals and colors while reducing redundant road/prop vertex uploads. Traffic keeps a fixed model pool, an indexed lane-spawn lookup and cached camera coverage. These are resource-budget improvements; actual FPS still depends on the GPU, viewport and scene.

Close-up skies also use tone-mapped EXR-derived panoramas on **background-depth pixels only**. Camera rays are transformed into local East/North/Up coordinates; terrain and buildings retain their existing color/depth. The backdrop fades into the native globe sky between 5 and 8 km above reference ground. Clear/cloudy/overcast are **illustrative presets selected using the available annual mean precipitation**: below 1.8, 1.8–3.6, and at least 3.6 mm/day respectively. Missing precipitation uses a neutral clear preset with unknown weather status. These thresholds provide visual regional variation; they do not estimate observed cloud cover, and future timeline values are not cloud forecasts. The sky manifest retains image-source/license metadata; runtime uses the small display images while the source EXRs stay cached outside the browser assets.

**Motion speed** controls wind/weather movement and timeline playback together. It defaults to 0.35×; zero pauses motion. Actual wind speed labels retain their source units and values. Graphics default to adaptive quality; View options allow a manual override.

Generation runs in a Web Worker, reuses GPU-instanced meshes and bounds buildings, tree clusters and crop patches. The procedural ground-material pass adds no mesh instances or extra draw calls. Per-model material colors are baked into linear vertex colors so a model/palette group uses one draw primitive. Full close-up detail arrives before its separate overview: the overview substitutes much smaller building/tree silhouettes, retains detailed data-center architecture, omits fine wheat geometry and reduces tree instances. Fine ground-material detail fades by projected pixel footprint while broad variation remains. Camera-height hysteresis switches the active model near 1.5 km above the reference ground (0.9 km in low quality), rather than drawing both levels together. Fine detail returns when descending.

Site changes release previous GPU models, shaders and local activity/atmosphere resources; close-up mode pauses the expensive distant weather solver and hides globe-only illustrative massing. Timeline landscape updates change shader uniforms without regenerating geometry. The selected site's bundled snapshot loads first, with additional real regions loaded on demand while panning. Close-up lighting disables HDR/bloom for a readable material palette while retaining quality-controlled shadows. City-life, local-atmosphere and distance-LOD adapters are implemented locally; cross-browser appearance/performance tuning remains part of the release checklist, rather than a promised frame rate.

Reproduce assets/maps with `python scripts/build-low-poly-assets.py`, `python scripts/fetch-neighborhoods.py`, and `python scripts/fetch-terrain.py`. Add `--preview-png` to the asset builder for a depth-tested model contact sheet; asset generation uses only Python's standard library. Data acquisition is bounded and cached; `scripts/stream-neighborhood.py` acquires additional pan destinations through the same adapters. `npm run test:web` checks placement, budgets, determinism, glTF transforms, water polygon/terrain behavior, DEM/scenario behavior and streaming lifecycle. See `data/cloudshadow/neighborhoods/README.md` for OSM/Copernicus/Open-Meteo provenance, attribution and limits, and `apps/web/assets/low-poly/README.md` for model dimensions, cluster counts and original-art provenance.

### Place names and population context

`data/cloudshadow/cities.json` contains **7,344 places total**: **7,339 Natural Earth** entries and **five 2020 U.S. Census city/CDP overrides**. Natural Earth's 1:10m populated-places catalog, version 5.1.2, supplies `POP_MAX` metro/micropolitan estimates with no reference year supplied. The app explicitly displays **“Metro est. … · year unavailable”**. Those estimates have a different geographic scope from administrative city populations. [Natural Earth source](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/).

The five case-study overrides use **Population, Census, April 1, 2020** counts and **2020 Gazetteer internal-point coordinates**:

| Place and census geography | Population | Source |
|---|---:|---|
| Ashburn CDP, Virginia | 46,349 | [Census QuickFacts](https://www.census.gov/quickfacts/fact/table/ashburncdpvirginia/POP010220) |
| Memphis city, Tennessee | 633,104 | [Census QuickFacts](https://www.census.gov/quickfacts/fact/table/memphiscitytennessee/POP010220) |
| Southaven city, Mississippi | 54,648 | [Census QuickFacts](https://www.census.gov/quickfacts/fact/table/southavencitymississippi/POP010220) |
| Abilene city, Texas | 125,182 | [Census QuickFacts](https://www.census.gov/quickfacts/fact/table/abilenecitytexas/POP010220) |
| The Dalles city, Oregon | 16,010 | [Census QuickFacts](https://www.census.gov/quickfacts/fact/table/thedallescityoregon/POP010220) |

The badge reports center-point proximity to a catalog place within 35 km when the camera is below 30 km; clicking it opens the population source. Up to 48 collision-checked labels are reused, updated at most twice a second. Names/populations remain fixed reference context as the environmental timeline changes. They do not count nearby facility workers, people in the rendered scene or future population. Rebuild the catalog with `python scripts/build-city-labels.py`; source archives stay under ignored `tmp/city-label-sources/`. Use `--download` to refresh the source archives while retaining the explicitly sourced 2020 overrides.

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
| **Forest groves, wheat and grass cover** | Modeled crowns/stems and continuous grass shading on suitable green ground. Yearly NDVI drives illustrative color/growth/thinning, not a crop census, yield estimate or individual mortality observation. | Mapped land cover, original cluster models, procedural grass material, yearly NDVI display input | `neighborhood-core.js`, `landscape-shader.js` |
| **Cars, people, planes and street details** | Mixed vehicles follow connected mapped routes with lane spacing, bounded turns and distant point LOD; quality ceilings are 150/300/510. Counts, speeds, people and flights are illustrative, not measured traffic/population/flight data. | Road surface paths/heights and mapped direction metadata, camera, campus footprint and original activity models | `traffic-routes.js`, `city-life.js`, `city-life-models.js` |
| **Local haze and clouds** | Camera-distance haze softens the scene edge; available wind/precipitation affect qualitative clouds. Neither haze nor cloud opacity measures pollution or cloud cover. | Camera/quality state and available yearly weather input | `local-atmosphere.js` |
| **Heat display** | Night heat remains in the HUD, heat layer and trend strip; no heat dome or floating embers. | `LST_Night_Local` | `timeline.js` |
| **Fluid weather field** (swirls on the ground, ~32 km) | Qualitative blue-gray wind/moisture wisps with transparent borders; no orange heat source. Combustion trace is gated to documented sources and does not scale with satellite NO₂ | `PlumeTowardDeg`, `WS10M`, `LST_Night_Local`, `NO2_Local`, `PrecipMMDay` | `fluid-gpu.js` (CPU fallback `fluid.js`), driven from `fx.js` |
| **Combustion plume** | Qualitative wind-driven particles only for explicitly documented combustion sites after onset. Close-up caption states “Illustrative combustion plume; not measured visible smoke.” Rate/particle density are not concentrations. | `sites.json → effects.plume`, onset and available yearly wind | `timeline.js` (globe), `campus-effects.js` (close-up) |
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
├── js/neighborhood.js  zoom/site lifecycle, base quick views, streamed patch readiness/fades and scene/shader cleanup
├── js/scene-compiler.js      progressive worker transport, cancellation and stale-message guards
├── js/scene-streaming.js     one-job request/poll queue, two-region LRU cache, abort/cooldown and circular fade policy
├── js/city-labels.js   bounded place labels, nearby context badge and fixed-reference population attribution
├── js/neighborhood-core.js   deterministic placement, campus classification, bounded vegetation, instanced GLB assembly
├── js/neighborhood-worker.js preview/detail/complete stages, one full plan, bounded off-main-thread build queue
├── js/scene-buffers.js prunes unused generated-GLB meshes, materials and binary views
├── js/surface-packing.js     shares exact Float32 surface vertices while preserving normals/colors
├── js/mesh-batching.js material-color baking into one primitive per model/palette, preserving flat normals
├── js/lod-mesh.js      small faceted distance substitutes; authored close-up models remain intact
├── js/terrain-mesh.js  faceted terrain, irregular smooth ground tints, exact polygon water and ground subtraction
├── js/surface-height.js      samples the rendered terrain triangles for road/traffic alignment
├── js/road-mesh.js     continuous mapped road surfaces, junctions and resampled traffic-path heights
├── js/street-infill.js bounded illustrative frontage placement with source/protected-area exclusions
├── js/urban-detail.js mapped paving/infrastructure and collision-checked illustrative backyards/details
├── js/recreation-detail.js   source-bounded courts, fields, playgrounds and park details
├── js/landscape.js     reference DEM sampling and explicitly illustrative landscape/vegetation helpers
├── js/landscape-shader.js    blended natural ground materials, detail fades, plant appearance and terrain scenarios
├── js/campus-effects.js      documented-combustion policy and disposable close-up plume particles
├── js/city-life.js     connected-path lane motion, camera-near car pooling, activity budgets and cleanup
├── js/traffic-routes.js      bounded mapped-road graph, one-way traversal, continuous turns and bumper spacing
├── js/city-life-models.js    original tiny car/plane/lamp/sign model pack
├── js/local-atmosphere.js    finite-scene distance fog, qualitative clouds and proximity fading
├── js/local-sky.js     background-depth sky panoramas and illustrative weather presets
├── js/sky-lighting.js  local image-based lighting lifecycle and asset loading
├── js/motion.js        shared wind/weather/playback motion-speed setting
├── js/adaptive-quality.js    frame-time sampling, quality tiers and cooldowns
├── js/vendor/earcut.js polygon triangulation; upstream ISC license is retained alongside it
├── js/fluid-gpu.js     WebGL2 stable-fluids sim (60 fps) draped on the globe
├── js/fluid.js         CPU fallback sim
├── assets/low-poly/    original 84-model kit, individual GLBs, manifest, geometry templates and preview
├── assets/sky/         EXR-derived display skies with source/license manifest
├── dev/fluid.html      fluid playground
└── server.cjs          local dev server + JSON API, including /api/neighborhood real-region acquisition
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
- Bundled study scenes and place labels work in the static build. Dynamic pan acquisition additionally needs the same-origin `/api/neighborhood` server and its Python adapters/provider access.
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
