# Unreal client implementation track

This folder holds the interactive explorer workstream.

**Current project: [`CloudShadow/`](CloudShadow/)**. Created with **Unreal Engine 5.8.3** on macOS, Blueprint/Python only (no C++ module), targeting **Cesium for Unreal v2.31.0** (first release with UE 5.8 builds). Setup steps and the NASA overlay URLs are in **[CLOUDSHADOW_SETUP.md](CLOUDSHADOW_SETUP.md)**.

Verified so far (UE 5.8.3, macOS): the project opens (after `xcodebuild -downloadComponent MetalToolchain`), the Python start-up script adds a **Cloud Shadow** editor menu, and the level builder ran cleanly and saved `/Game/CloudShadow/Maps/CloudShadow` (georeference, terrain + 10 NASA overlay components, Google 3D Tiles, SunSky, Dynamic Pawn, 5 site pillars). **Not yet verified:** on-screen rendering of terrain/overlays, which needs each user to connect a Cesium ion account (the per-user token asset `Content/CesiumSettings/` is git-ignored). No packaged build exists. Unreal `.uasset`/`.umap` files are stored with Git LFS (`git lfs install` before pulling).

Start with [the Unreal/Cesium integration plan](../../docs/unreal-integration.md), then use [the API contract](../../docs/api.md) to connect a new Unreal project to the local Node backend. The [architecture document](../../docs/architecture.md) explains the three component boundaries.

The first client milestone is a globe with a region selector, a scenario form, asynchronous run status, and charts for the worker's four synthetic accounting outputs. All unsupported environmental, socioeconomic, and noise outputs must stay visibly unavailable.

When creating the project here:

- Record the chosen Unreal and Cesium versions.
- Keep generated caches, build outputs, provider credentials, and large external tiles out of Git.
- Use HTTP/WS locally and HTTPS/WSS for a secured remote backend.
- Follow the documented local-terrain and independent-data rules.
- Do not claim a functional Unreal build until it has been created, compiled, and tested in the selected engine version.

## Fab assets for the Footprint Atlas film (not in Git)

The 2021 meadow in the intro film uses free Fab / Quixel assets. Their license allows use in the
project and its rendered output, not redistribution, so they are git-ignored. To rebuild the film
on another machine, first enable the **Procedural Vegetation Editor** plugin (already in the
.uproject; restart the editor), then in **Window > Fab** add these to the project:

| Kind | Fab listing |
|---|---|
| Trees (Nanite, wind) | Megaplants: Norway Maple Forest; Megaplants: English Oak; Megaplants: European Hornbeam |
| Grass and flowers | Wild Grass; Grass Clumps; Goldenrods; Field Poppy; White Everlasting; Violet Wood Sorrel |
| Ground | Ground Rubble (surface); Nordic Mossy Ground; Industrial Abandoned Factory Ground Patch (Gravel); Military Trenches Ground Patch (Rock) |

They land in `Content/Fab/` and `Content/Megaplant_Library/`. Nanite Foliage (assemblies + voxels)
is already enabled in `Config/DefaultEngine.ini`; without it the Megaplants render without leaves.
Then run `import cloudshadow_env as env; env.build()` and `import cloudshadow_cine as c; c.build(); c.build_sequence()`
in the editor Python console.
