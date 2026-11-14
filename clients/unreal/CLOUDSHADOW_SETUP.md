# Cloud Shadow in Unreal Engine

The plan: **Unreal = the cinematic 3D globe. The repo's data pipeline = the science.**
Unreal reads the same NASA tiles (as map overlays) and the same results (as a DataTable), and can embed the web analysis panel.

```
NASA GIBS tiles ──► scripts/precompute.py ──► data/cloudshadow/series/*.json ──► web app (index.html)
       │                                              │
       │                                   scripts/export_unreal.cjs
       ▼                                              ▼
Cesium raster overlay in UE          data/cloudshadow/unreal/CloudShadowSites.csv  ──► DataTable ──► site actors
```

---

## ⚡ Quick start (the project already exists: `clients/unreal/CloudShadow/`, created with UE 5.8.3)

1. **Engine:** UE **5.8** (Cesium for Unreal v2.31.0, Oct 2026, ships 5.8 builds).
2. **Cesium plugin (required):** Epic Launcher → **Fab** → "Cesium for Unreal" → **Install to Engine (5.8)**, *before* opening the project. On a Mac, also run `xcodebuild -downloadComponent MetalToolchain` once, or UE 5.8 can't compile shaders.
3. **Git LFS** (once per machine): `git lfs install`, *before* cloning or pulling, so `.uasset`/`.umap` files come down correctly.
4. Open `clients/unreal/CloudShadow/CloudShadow.uproject`. The first launch compiles shaders, so give it time.
5. **Window → Cesium → Connect to Cesium ion** (free account). **Everyone does this on their own machine.** The token is stored in `Content/CesiumSettings/`, which is git-ignored on purpose. Until you connect, the globe is blank and the log shows `401` errors; that's expected.
6. **The level is already built and committed** (`/Game/CloudShadow/Maps/CloudShadow`); just open it. To rebuild from scratch, use menu bar → **Cloud Shadow → Build Cloud Shadow level**. It contains:
   - georeference on xAI Colossus 1; Cesium World Terrain + Bing aerial
   - 10 NASA overlay components on the terrain (NO₂ 2025 active; NO₂ 2023, heat day/night, NDVI, HLS before/after for Colossus 1 & 2, OPERA disturbance ready to toggle)
   - Google Photorealistic 3D Tiles (hidden; unhide it and hide the terrain for city close-ups)
   - SunSky, Dynamic Pawn, glowing site pillars (height = MW) + labels + Boxtown marker
   Re-running it replaces everything it made (tag `CloudShadow`). **Cloud Shadow → Check setup** prints what's missing.
7. Toggle an overlay: select *Cesium World Terrain* → Details → pick the overlay component → **Activate/Deactivate** (only one `Overlay1` layer should be active at a time). In Blueprint: `Get Component by Name → Deactivate / Activate`.
8. For live data in Blueprints: run `npm run web` in the repo and call `http://localhost:8765/api/...` with the **HttpBlueprint** and **JsonBlueprintUtilities** plugins (already enabled).

The sections below explain each piece by hand, in case you want to build it differently.

---

## 1. Engine + plugin (≈20 min, mostly downloads)

1. **Engine:** use **UE 5.8.3** *if* the Cesium for Unreal page on Fab lists 5.8 as supported. If it doesn't, install **5.7** (Epic Launcher → Unreal Engine → Library → `+` next to *Engine Versions*).
2. **Cesium for Unreal:** Epic Launcher → **Fab** → search "Cesium for Unreal" (free) → **Install to Engine** → pick your version.
3. **Free Cesium ion account:** https://ion.cesium.com/signup. You need it for world terrain, satellite imagery and Google Photorealistic 3D Tiles.

## 2. Project setup

1. New project → **Games → Blank**, Blueprint, Desktop, quality **Maximum**, *no* starter content. Name it `CloudShadow`.
   Put it in this repo at `clients/unreal/CloudShadow/` (the repo's `.gitignore` already excludes `Binaries/ Intermediate/ Saved/ DerivedDataCache/`). **This is already done**: the project exists at `clients/unreal/CloudShadow/`.
2. **Edit → Plugins**, enable **Cesium for Unreal**, **Web Browser** (to embed the web panel) and **Python Editor Script Plugin** (optional). Restart.
3. **Window → Cesium** opens the Cesium panel. Click **Connect to Cesium ion** and log in.
4. In the Cesium panel → **Quick Add**:
   - **Cesium World Terrain + Bing Maps Aerial imagery** (best for draping NASA overlays)
   - **Google Photorealistic 3D Tiles** (the "wow" close-up of Memphis buildings)
   - **Cesium SunSky** + **Dynamic Pawn**
5. Select **CesiumGeoreference** and set the origin to xAI Colossus 1:
   `Latitude 35.0601 · Longitude -90.1564 · Height 100`

## 3. Drape NASA data on the globe (the key visual)

Select the **Cesium World Terrain** actor → **Add Component** → **Cesium Url Template Raster Overlay**.
(Older plugin versions don't have it; use **Cesium Web Map Tile Service Raster Overlay** instead, see the bottom of this section.)

| Setting | Value |
|---|---|
| Template URL | one of the URLs below |
| Projection | Web Mercator |
| Minimum Level | 0 |
| Maximum Level | the `Level` number in the URL (6, 7, 9 or 12) |
| Tile Width / Height | 256 |

Change the date in the URL to change time. Ready-made URLs:

**Air: NO₂ (TROPOMI, daily, from Sep 2023). Use for Memphis turbines:**
```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column/default/2025-07-15/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png
```
**Surface heat, day / night (MODIS 8-day, 2000→today):**
```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_Land_Surface_Temp_8Day_Day/default/2025-07-12/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_Land_Surface_Temp_8Day_Night/default/2025-07-12/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png
```
**Greenness NDVI (MODIS 16-day):**
```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_16Day/default/2025-07-12/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png
```
**30 m true colour, cloud-free dates already picked (before → after):**
```
Colossus 1  BEFORE https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2023-06-29/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png
Colossus 1  AFTER  https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2025-07-08/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png
Colossus 2  BEFORE https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2024-06-13/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png
Colossus 2  AFTER  https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/2026-06-20/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png
```
(All sites' best dates are in `data/cloudshadow/hls_dates.json`.)

**Land disturbance (OPERA, yearly 2023–2025):**
```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OPERA_L3_DIST-ANN-HLS_Color_Index/default/2025-01-01/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png
```

**Before/after in Unreal:** add two overlay components with different dates. Toggle them from a key press or a UMG button (`Activate` / `Deactivate` on the component), or key them in Sequencer for the video.

<details><summary>WMTS overlay settings (if Url Template isn't available)</summary>

| Setting | Value |
|---|---|
| Base Url | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi` |
| Layer | e.g. `TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column` |
| Style | `default` |
| Format | `image/png` |
| Tile Matrix Set ID | e.g. `GoogleMapsCompatible_Level6` |
| Use Web Mercator Projection | ✓ |
| Dimensions / TIME | `TIME=2025-07-15` (if your plugin version exposes it) |
</details>

> Tip: colour legends for each layer are at `https://gibs.earthdata.nasa.gov/legends/<LayerName>_H.svg`. Drop one into a UMG image.

## 4. Site markers from the DataTable

1. **Create the struct:** Content Browser → right-click → Blueprint → **Structure**, name it `S_CloudShadowSite`, with these fields (names must match the CSV header):

   | Field | Type | | Field | Type |
   |---|---|---|---|---|
   | DisplayName | String | | LSTDayChange | Float |
   | Place | String | | LSTDayP | Float |
   | Latitude | Float (double) | | LSTNightChange | Float |
   | Longitude | Float (double) | | LSTNightP | Float |
   | Onset | String | | AirTempChange | Float |
   | PowerMW | Float | | AirTempP | Float |
   | NO2Change | Float | | NDVIChange | Float |
   | NO2P | Float | | NDVIP | Float |
   | AODChange | Float | | WindFromDeg | Float |
   | AODP | Float | | PlumeTowardDeg | Float |
   | | | | WindSpeedMS | Float |
   | | | | Headline | String |

2. **Import** `data/cloudshadow/unreal/CloudShadowSites.csv` by dragging it into the Content Browser. Choose **DataTable**, row struct `S_CloudShadowSite`.
3. **BP_SiteMarker** (Actor): add a **Cylinder** mesh (emissive orange material), a **Text Render** (or a Widget component) and a **CesiumGlobeAnchor** component.
   Expose a `Row` variable of type `S_CloudShadowSite`. On BeginPlay:
   - `CesiumGlobeAnchor → Move to Longitude Latitude Height (Longitude, Latitude, 0)`
   - Cylinder Z scale = `4 + sqrt(PowerMW) * 1.1` (same rule as the web app, **pillar height = power draw**)
   - Text = `DisplayName + "\n" + PowerMW + " MW"`
4. **Level Blueprint → BeginPlay:** `Get Data Table Row Names` → **For Each** → `Get Data Table Row` → **Spawn Actor BP_SiteMarker** (pass the row).
5. **Significance colouring (optional):** if `NO2P < 0.05`, pulse the marker material red. That's an "officially significant" signal.

## 5. Embed the analysis panel (charts + stats + ledger)

1. On any computer with the repo: `npm run web` in the repo folder.
2. UMG Widget → add **Web Browser**. Initial URL:
   `http://localhost:8765/?embed=1&site=colossus1&var=NO2`
   (`site` = `colossus1 | colossus2 | ashburn | abilene | thedalles`, `var` = `NO2 | NO2_OMI | LST_Day | LST_Night | NDVI`)
3. When the camera flies to a site, call **Load URL** with that site's id. The panel follows.

## 6. The demo flythrough (Sequencer)

Suggested 60–90 s shot list (same story as the web app's guided tour):
1. Space view of North America, site pillars glowing (height = MW).
2. Dive to Memphis → Google 3D Tiles close-up of Colossus 1. Boxtown 3 km away.
3. Fade NO₂ overlay on: before (2023) → after (2025).
4. Cut to Colossus 2: HLS before/after wipe, the land disappears.
5. Pull back to Data Center Alley (Ashburn): 20 years of heat and greenness change.
6. End card: the significant findings (NO₂ up next to Boxtown, Ashburn's nights warmer than the region), each with its p-value and "Data: NASA".

Use **CesiumFlyToComponent** on the Dynamic Pawn for smooth globe-scale flights, or keyframe a CineCamera in Sequencer. Cesium handles the georeferencing.

## 7. Refreshing data

```bash
python3 scripts/precompute.py          # pull NASA tiles → data/cloudshadow/series/*.json (cached, ~10 min first run)
python3 scripts/precompute.py --hls    # also re-pick cloud-free 30 m dates
npm run data:unreal          # → data/cloudshadow/unreal/*.csv / *.json
```
Then right-click the DataTable in Unreal → **Reimport**.
