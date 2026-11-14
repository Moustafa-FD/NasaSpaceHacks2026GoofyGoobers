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
