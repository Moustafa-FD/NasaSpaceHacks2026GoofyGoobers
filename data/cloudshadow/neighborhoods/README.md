# Local neighborhood map snapshots

The five `<site>.json` files contain **real, current OpenStreetMap geometry** around the app's existing study sites: building footprints, road and path centerlines, mapped land-cover/land-use boundaries, waterways, and individually mapped trees. They are precomputed inputs for the local low-poly renderer. Close-up panning can additionally acquire bounded real regions through the development server's `/api/neighborhood` endpoint, using the same source adapters and provenance rules.

Dynamic requests use quantized 0.01° centers, one serialized provider-acquisition job and a bounded queue. Public-provider work can take tens of seconds or longer; the endpoint returns `202` with `retryAfterMs` while pending and `503` with a cooldown on failure. New bundles retain source timestamps/status and their actual center; unknown map/elevation data are not fabricated. Up to twelve dynamic bundles live under ignored `tmp/streamed-neighborhoods/`, separately from these checked-in study snapshots. The browser retains existing geometry until replacement GPU readiness, then blends overlapping circular regions with soft edges. It caches two compiled streamed regions and retains the selected base scene for quick views. See [the web guide](../../../apps/web/README.md#low-poly-neighborhoods-and-landscape) for API states, delays, visual boundaries and static-deployment behavior.

**Attribution: © OpenStreetMap contributors.** This derived map database is available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Preserve visible attribution and the [OpenStreetMap copyright link](https://www.openstreetmap.org/copyright) when displaying or redistributing it. The ODbL applies to these map-data snapshots, not a newly asserted license for this project's code or original 3D model artwork.

## Reproduce

From the repository root, using Python 3.11+ and its standard library:

```sh
python scripts/fetch-neighborhoods.py
python scripts/fetch-neighborhoods.py --validate
```

The first command reuses valid saved snapshots. `--refresh` deliberately requests replacements. `--site ashburn` limits acquisition to one of the five known site IDs; repeat `--site` to select several. There are at most two simultaneous requests and two attempts per site per invocation, each with a 60-second timeout and a 32 MiB decoded-response budget. `--attempts 1` permits only one request. Requests use the public Overpass endpoints recorded in `source.endpoint`. A failed refresh preserves an existing valid file; failures are explicit in the generated report and are never replaced by invented map records. A rate-limited source should be given its cooldown before an explicit retry.

For an expensive region, `--ways-only --attempts 1` makes a lighter bounded query that omits multipolygon relations. That limitation is recorded in `source.queryScope`; it can reduce forest/water coverage and is not equivalent to a full query.

## Coordinates and contents

- `center.lat/lon` are the site's geographic coordinates from `sites.json`.
- `polygon` and `points` coordinate pairs are **[east meters, north meters]** relative to that center, using a local equirectangular projection with the WGS84 semi-major radius. Values are rounded to centimeters for compact storage. This is a local display projection, not a survey-grade coordinate reference system.
- `radiusM: 3300` is the square's half-extent: the downloaded bounding box and clipped output cover **6.6 km × 6.6 km**, not a precise 3.3 km circle. `extentM` is `[-3300,-3300,3300,3300]` in local meters.
- Building `tags` retain mapped building class, levels, height, roof information, name and start date when supplied. Missing heights, dates, roof details and levels remain missing. A renderer may choose illustrative model details but must not call them observed architecture.
- Road `width` uses OSM's `width` when supplied; otherwise it is an **illustrative class-based width**. `widthSource` distinguishes the two. Roads include service lanes and footpaths; a renderer should choose a suitable visual budget rather than turning every centerline into a major street.
- Multipolygon relation outer ways are joined; inner rings are retained as `holes`. Polygons and crossing line segments are clipped to the finite local extent. Area `kind` is a display classification of source tags; it is not an independently measured vegetation or agricultural survey.
- `trees` are individually mapped point features only. A renderer can add clearly illustrative tree placement inside mapped forest/park areas. A count of zero mapped tree points does not mean no real trees exist.
- `waterways` preserves mapped river/stream/canal/drain/ditch centerlines without inventing measured channel widths.

Each snapshot records the acquisition time, source database timestamp, endpoint, original response SHA-256, and license. `report.json` records acquisition status, feature counts, and file sizes.

## Scientific and visual boundaries

OpenStreetMap is an incomplete contributed map. Feature detail and coverage vary between sites. These snapshots describe the map at acquisition time; they **do not reconstruct historical building or tree locations** when the app's environmental timeline moves to an earlier year. Modeled roofs, facades, colors, missing-height assumptions, and scattered vegetation are illustrative scenery. The detailed scenery does not increase the scientific resolution of NASA environmental data or establish facility causation.

## Supplemental paving and infrastructure

The five `urban-<site>.json` files preserve contributed OSM parking lots, explicitly paved commercial/industrial parcels, mapped airport runways/taxiways/aprons, road width/lane/service tags, crossings, power lines and support/signal nodes. Airport boundaries alone are not paved. An absent airport or power feature is not replaced with an invented one. Each acquisition retains its endpoint, download time, response SHA-256, license and query scope; `source.infrastructure` records the separate infrastructure acquisition. Existing paving and airport geometry survives an infrastructure refresh or provider failure.

```sh
python scripts/fetch-urban-detail.py
python scripts/fetch-urban-detail.py --validate
python scripts/fetch-urban-detail.py --infrastructure-only
python scripts/fetch-urban-detail.py --map-infrastructure --site ashburn --map-radius 1000
```

The normal Overpass query covers the existing 6.6 km square, with at most two simultaneous requests, two endpoint attempts, a 60-second timeout and a 16 MiB response limit. `--infrastructure-only` merges new infrastructure and service-road tags into a ready cache. `--map-infrastructure` is an explicit, cached fallback using one small [OSM API map request](https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_/api/0.6/map) per selected site after Overpass failures; it has a 45-second timeout, a 16 MiB limit and no automatic retry. `--map-radius` accepts 800, 1000 or 1600 meters. These smaller infrastructure query extents do not replace the original paving/airport coverage. `--refresh` explicitly requests a new acquisition; validation makes no network requests. Failed updates are recorded under `source.infrastructureRefresh` and preserve ready source data.

Current infrastructure cache counts are source records, not a complete infrastructure census or the number of models drawn:

| Site | Power-line ways/chunks | Towers | Poles | Traffic-signal nodes | Infrastructure query half-extent |
|---|---:|---:|---:|---:|---:|
| Colossus 1 | 85 | 183 | 468 | 0 | 1,600 m |
| Colossus 2 | 96 | 109 | 677 | 6 | 1,600 m |
| Ashburn | 14 | 24 | 320 | 23 | 1,000 m |
| Abilene | 21 | 135 | 174 | 0 | 1,600 m |
| The Dalles | 29 | 42 | 44 | 2 | 1,600 m |

The map endpoint returns ways touching the requested square and their referenced nodes, so some returned source geometry extends beyond that smaller query extent. Output remains clipped to the original local 3,300 m half-extent. Infrastructure outside the smaller query coverage is unknown; a zero count is not evidence of real-world absence. The Dalles is the only bundled scene with mapped airport operational geometry: three runway chunks, 59 taxiway chunks and four aprons.

The supplemental geometry uses the same local `[east,north]` meters as the main snapshots. `surfaces` contains `{id,kind,polygon,holes?,tags}`, `airways` contains `{id,kind,points,width,widthSource,tags}`, and `airports` retains aerodrome boundaries for context. `roadTags` retains `{id,tags}` keyed by the original OSM way ID. `powerLines` contains `{id,kind:'line'|'minor_line',points,tags}`; `infrastructureNodes` contains `{id,kind:'tower'|'pole'|'traffic_signals',x,y,tags}`. Heights are retained only when mapped. Renderer height estimates, tower trusses, signal hardware, conductor thickness, parabolic wire sag and conservative display clearances are illustrative and unsuitable for engineering or navigation.

Missing road widths use explicitly labelled class, service-type or mapped-lane estimates; explicit OSM widths take precedence. Mapped driveways and parking aisles retain their source paths. Additional house driveways/front walks are labelled illustrative, connect only short gaps up to 35 m to adjacent local/service roads, and reject water, other building footprints and major-road crossings. Garden fences, hedge strips, beds and patios are bounded scenery around mapped homes, not ownership or cadastral boundaries. Detailed yard sets and connections are prioritized near the Homes quick-view focus. Green garden vegetation follows the same illustrative vegetation display-health controls as other planting.

Infrastructure uses batched geometry with a 28,000-triangle sub-budget; close rendering caps tiny signal/pole hardware, and overview rendering keeps simplified towers and major lines. Gardens share a 32,000-triangle sub-budget. The entire urban layer remains capped at 160,000 close / 45,000 overview triangles. Render statistics distinguish source line ways from rendered spans and hardware; budgets can omit source features, so rendered counts must not be presented as observed infrastructure totals.

Traffic connectivity is compiled once from the close road-surface paths in `neighborhood-worker.js`, alongside scene generation. The overview shares that graph. Its Maps and arc references cross the worker boundary by structured clone; model buffers transfer separately. Each newly generated patch receives fresh mutable traffic locks. Traffic remains an illustrative animation over current source paths rather than measured traffic or historical route reconstruction.

## Real baseline elevation

`elevation-<site>.json` holds a **17 × 17** grid of real point elevations from the [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api), which documents its source as **Copernicus DEM 2021 GLO-90** with **90 m native resolution**. The saved display grid samples the 6.6 km square at **412.5 m spacing**; interpolating it in the browser does not create additional measured detail. Copernicus DEM is a digital **surface** model, which can include vegetation and structures; this is not a surveyed bare-earth parcel model.

```sh
python scripts/fetch-terrain.py
python scripts/fetch-terrain.py --validate
node --test tests/landscape.test.js
```

The fetcher reuses ready snapshots and resumes missing batches of at most 100 coordinates. Public requests are spaced 11 seconds apart across at most two threads; HTTP 429 ends that site's work without immediate retry. Explicitly resume after the provider cooldown. `--site <id>` limits the region; `--refresh` deliberately replaces samples only after a successful refresh. Failed or missing values remain `null`, with `status` set to `partial` or `unknown`; they are never silently zero-filled. Each successful response batch records its time and SHA-256.

Elevation schema:

- `width`, `height`: both 17; `heights`: a flat row-major array.
- Rows progress **south to north**, columns **west to east**. `heights[row * width + col]` corresponds to `x = -3300 + col * 412.5`, `y = -3300 + row * 412.5` in the same local meters as the OSM snapshot.
- Values are absolute source elevation in meters. Copernicus uses the **EGM2008 orthometric vertical datum**. No geoid-to-WGS84-ellipsoid conversion is applied; direct Cesium local placement is an approximate visual alignment, not a precise engineering elevation transform.
- `sampleElevation()` in `apps/web/js/landscape.js` uses bilinear interpolation and returns `null` outside coverage or where required corner samples are missing. `createLandscape().heightAt()` returns the same absolute baseline unless a scenario is explicitly enabled.

**Elevation attribution: Copernicus DEM / European Union and Open-Meteo.com.** Open-Meteo API data are supplied under [CC BY 4.0](https://open-meteo.com/en/licence). Preserve the Open-Meteo and Copernicus attribution, license link, and the indication that samples have been interpolated/stylized. Recommended DEM citation: [doi:10.5270/ESA-c5d3d65](https://doi.org/10.5270/ESA-c5d3d65). Dataset reference: [Copernicus DEM collection](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM).

### Timeline and illustrative landscape scenario

The real DEM is static reference data; selecting another historical or future environmental year **does not alter the baseline terrain**. A separate, **default-off illustrative scenario** can ease from the 2025 baseline toward 2035: up to 180 m Gaussian mountain uplift, a small curved valley deformation, an 8 m water-level offset, and an artistic shoreline-color advance near mapped water. This is a visual exploration, **not measured historic erosion, geological forecasting, flood routing, or a calibrated impact model**. The shader's blue shoreline treatment is not a flat-water flood-volume solver.

`healthAt()` accepts a normalized vegetation display-health input, not raw NDVI. It applies deterministic spatial patchiness while preserving missing inputs and never infers ecological decline from the calendar alone. The renderer may use actual yearly NDVI to drive that display input; regional NDVI does not measure the health or death of a particular individual tree or crop yield. Shader-only scenario stress, plant growth scaling, canopy disappearance and crop colors are illustrative details.

`apps/web/js/landscape-shader.js` provides `createLandscapeShader(Cesium, elevation, {center})`; the optional center preserves geographic material alignment when elevation is unavailable. Update its `u_health`, `u_year`, and `u_scenario` uniforms instead of rebuilding geometry for each year. Every primitive must carry `_VEGETATION` (0 other, 1 tree, 2 crop, 3 ground, 4 water) and `_WATER_DISTANCE` (signed meters from a mapped water boundary; large positive value if unknown). Its texture uses packed unsigned 16-bit elevation plus a valid-sample mask, decoded before bilinear interpolation. The app must destroy the custom shader when the scene model is destroyed to release the texture.

The original architectural/vegetation kit contains 84 models. Grass on suitable green ground is a continuous geographically anchored material, not a grid of generated tuft meshes; it adds no geometry or draw calls. Fine blade-like color/roughness detail fades by projected pixel footprint, leaving subtle broad variation in distant and overview views. Buildings, roads, paving, courts and water keep their own materials, and scenario-flooded ground receives the water override. The overview omits fine wheat geometry and uses simplified tree silhouettes. Grass patterns, species choices and vegetation-display responses are illustrative styling, not surveyed botanical coverage or additional measured detail.

Supplemental urban-<site>.json files preserve OSM parking/paving, runway/taxiway/apron geometry, available road width/lane tags and crossing nodes. All five snapshots are ready; queryScope records smaller surface-only retries where road/crossing metadata was unavailable. Airport boundaries alone do not create paving. Parking paint, parked cars, gardens, campus grouping and fences are bounded illustrative scenery, not surveyed property limits.
