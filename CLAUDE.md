# Claude Code handoff: Goofy Goobers, NASA Space Apps 2026

@AGENTS.md

## Who / when
- Team **Goofy Goobers**, NASA Space Apps Toronto (Centennial College, Downsview). Hackathon **Nov 14–15, 2026**; submission deadline **Sun Nov 15, 11:59 pm local**.
- Challenge: **Be An Earth System Trend Detective!** (pick NASA variables → time series → trend + significance: Mann-Kendall / t-test / CIs).
- Demo for judges: **7 slides max or a 30-second video**. Judging = Impact, Creativity, Validity, Relevance (NASA data must be core), Presentation.

## The project: "Cloud Shadow"
Environmental footprint of data centers on a 3D globe, measured with NASA data. Lead story: **xAI Colossus, South Memphis** (on-site methane gas turbines, Boxtown neighborhood ~3 km away). Other sites: xAI Colossus 2 (Memphis), Data Center Alley (Ashburn VA), Stargate Abilene TX, Google The Dalles OR.

**Decisions already made (don't relitigate):**
- **Focus = weather/heat + air pollution.** Jobs, taxes and electricity bills were deliberately dropped from our part (no NASA data → weak "Relevance"). The teammate scaffold keeps those domains as clearly marked *unavailable*; leave that alone.
- Report statistics honestly. Borderline stays "borderline". Satellite change near a facility = evidence, not proof of attribution.
- MERRA-2 regional air temperature is the **climate control**: a site signal must beat the regional trend.

**Current results** (`data/cloudshadow/`, see `docs/cloud-shadow.md`):
- Ashburn: region +0.71 °C/decade (p=0.001); site night surface heat +0.25 °C/decade beyond surroundings (p=0.001). **Strongest result.**
- Colossus 1: NO₂ +0.24×10¹⁵ molec/cm² after mid-2024 (p=0.051, borderline). NDVI −0.07 (p<0.001). AOD sparse (riverbank).
- Colossus 2: NDVI −0.12 (p=0.047). AOD: no significant increase anywhere.

## Where things are
| Part | Path | Run |
|---|---|---|
| Web explorer (CesiumJS) + NASA trend API, port 8765 | `apps/web/` (`server.cjs`) | `npm run web` |
| NASA GIBS adapter (tiles → colormap-decoded values) | `scripts/precompute.py` | `npm run data:nasa` (needs `pip install pillow`) |
| Shared stats (Mann-Kendall, Sen, Welch, de-seasoning) | `apps/web/js/stats.js` (verified vs SciPy) | |
| Unreal export (DataTable CSV/JSON) | `scripts/export_unreal.cjs` → `data/cloudshadow/unreal/` | `npm run data:unreal` |
| Unreal project | `clients/unreal/CloudShadow/` | guide: `clients/unreal/CLOUDSHADOW_SETUP.md` |
| Teammate scaffold (scenario API on :3000, Python worker, contracts) | `apps/api/`, `services/models/`, `packages/contracts/` | `npm start`, `npm run check` |

Root `package.json` is `"type": "module"`, so our Node files are `.cjs`. `npm run check` must stay green (typecheck + 8 API tests + 12 model tests).

## Unreal status
- UE **5.8.3** + **Cesium for Unreal 2.31.0** (required plugin; install from Fab → *Install to Engine 5.8* before opening).
- Level `/Game/CloudShadow/Maps/CloudShadow` is **built and committed** (via `Content/Python/cloudshadow_setup.py`, also on the editor menu **Cloud Shadow → Build Cloud Shadow level**): georeference on Colossus 1, Cesium World Terrain + Bing (Overlay0), 10 NASA GIBS `CesiumUrlTemplateRasterOverlay` components on `Overlay1` (only NO₂ 2025 active), hidden Google 3D Tiles, SunSky, DynamicPawn, 5 site pillars (height = MW) + Boxtown marker.
- **Not yet verified on screen**: terrain and overlay rendering. Each person must do **Window → Cesium → Connect to Cesium ion** on their own machine. The token lives in `Content/CesiumSettings/`, which is git-ignored on purpose. Never commit it.
- `.uasset`/`.umap` go through **Git LFS**.

## Windows laptop setup (the team's 3D machine)
1. `git lfs install` **before** cloning/pulling, or the `.umap`/`.uasset` files arrive as pointer text.
2. Unreal Engine 5.8 via Epic Launcher; Fab → Cesium for Unreal → Install to Engine 5.8. Blueprint/Python-only project: Visual Studio is not required.
3. Node.js 24+, Python 3.11+ on PATH as `python`. Then `npm ci`.
4. Open `clients/unreal/CloudShadow/CloudShadow.uproject`, connect Cesium ion, open the CloudShadow level, press Play.
5. (macOS only: `xcodebuild -downloadComponent MetalToolchain`. Not needed on Windows.)

## Next steps (suggested)
1. Verify rendering in Unreal; tune overlay opacity/material so NASA layers blend with imagery.
2. Before/after toggles (keys or UMG buttons) for the NO₂ 2023↔2025 and HLS 30 m overlays; a Sequencer flythrough for the **30-second demo video** (shot list in `CLOUDSHADOW_SETUP.md` §6).
3. Optional: UMG widget showing `/api/analysis?site=…&var=…` (HttpBlueprint + JsonBlueprintUtilities plugins are enabled), or embed `http://localhost:8765/?embed=1&site=colossus1&var=NO2` in a Web Browser widget.
4. Slides (≤7) built around: problem → NASA data → method (site vs. ring, de-seasoned, Mann-Kendall) → Ashburn + Memphis results with p-values → limits → globe demo.
5. Submit on the Space Apps site before the deadline, listing all external resources in References.
