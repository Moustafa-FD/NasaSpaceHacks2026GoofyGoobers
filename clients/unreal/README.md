# Unreal client implementation track

This folder reserves the interactive explorer workstream. No Unreal project, assets, compiled networking wrapper, or packaged application is included yet.

Start with [the Unreal/Cesium integration plan](../../docs/unreal-integration.md), then use [the API contract](../../docs/api.md) to connect a new Unreal project to the local Node backend. The [architecture document](../../docs/architecture.md) explains the three component boundaries.

The first client milestone is a globe with a region selector, a scenario form, asynchronous run status, and charts for the worker's four synthetic accounting outputs. All unsupported environmental, socioeconomic, and noise outputs must stay visibly unavailable.

When creating the project here:

- Record the chosen Unreal and Cesium versions.
- Keep generated caches, build outputs, provider credentials, and large external tiles out of Git.
- Use HTTP/WS locally and HTTPS/WSS for a secured remote backend.
- Follow the documented local-terrain and independent-data rules.
- Do not claim a functional Unreal build until it has been created, compiled, and tested in the selected engine version.
