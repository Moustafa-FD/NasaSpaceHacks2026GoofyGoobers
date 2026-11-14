# Local neighborhood map snapshots

The five `<site>.json` files contain **real, current OpenStreetMap geometry** around the app's existing study sites: building footprints, road and path centerlines, mapped land-cover/land-use boundaries, waterways, and individually mapped trees. They are small precomputed inputs for the local low-poly renderer; zooming does not submit a new Overpass request.

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

`apps/web/js/landscape-shader.js` provides `createLandscapeShader(Cesium, elevation)`. Update its `u_health`, `u_year`, and `u_scenario` uniforms instead of rebuilding geometry for each year. Every primitive must carry `_VEGETATION` (0 other, 1 tree, 2 crop, 3 ground, 4 water) and `_WATER_DISTANCE` (signed meters from a mapped water boundary; large positive value if unknown). Its texture uses packed unsigned 16-bit elevation plus a valid-sample mask, decoded before bilinear interpolation. The app must destroy the custom shader when the scene model is destroyed to release the texture.

Supplemental urban-<site>.json files preserve OSM parking/paving, runway/taxiway/apron geometry, available road width/lane tags and crossing nodes. All five snapshots are ready; queryScope records smaller surface-only retries where road/crossing metadata was unavailable. Airport boundaries alone do not create paving. Parking paint, parked cars, gardens, campus grouping and fences are bounded illustrative scenery, not surveyed property limits.
