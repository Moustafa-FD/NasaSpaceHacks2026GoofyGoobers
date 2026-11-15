# Repository guidance

## Architecture

- `apps/api/`: environmental Node/TypeScript validation, persistent local jobs, source adapters and client gateway on port 3000.
- `services/data/`: NASA POWER acquisition/decoding worker; stdout carries JSON progress/results and diagnostics go to stderr. `services/models/` retains the inactive illustrative accounting worker.
- `packages/contracts/src/environment.ts`: active environmental types/runtime validation; the older JSON Schemas and `src/index.ts` describe the inactive accounting fixture.
- `apps/web/`: existing web explorer/statistics and separate port-8765 API, reading `data/cloudshadow/`; it is not automatically connected to the environmental gateway.
- `clients/unreal/`: existing Unreal project/assets, setup and cinematic-client workflow. Preserve that team implementation; a connector to the expanded environmental gateway remains separate work.
- `docs/`: architecture, API, evidence rules, resources, Unreal integration and roadmap.

## Evidence and scope

- Preserve each source's evidence class, units, quality flags, provenance and actual coverage. Acquisition checks do not establish model accuracy; retained `illustrative`/`synthetic` fixtures must keep those labels.
- Unsupported domains must have a reason; never substitute zero or fabricate a map.
- Current scope is environmental: weather/heat, air pollution/quality, water availability/quality, land/vegetation/ecosystems, noise and agriculture. The explicitly requested city-bills view adds sourced residential electricity histories with bounded trend projections, plus official water tariffs and labeled fixed-use bill examples where available. Published water references must not be presented as a historical series or future forecast. Neither establishes data-center-attributable price effects. Labor/employment and population projections remain out of scope; older planning notes do not reactivate them.
- STRATA recursion is not evidence for accurate decades-ahead forecasts. Each metric needs its own validated horizon and uncertainty.
- Water use, net consumption, quality and scarcity are separate outputs. Agricultural climate exposure, vegetation proxies and measured crop yields are separate quantities.
- Do not infer facility attribution from nearby satellite changes alone.

## Engineering

- Run `npm run check`; use focused meaningful checks for changed behavior.
- Keep schema/type/Python validation/API/client docs aligned on changes.
- Do not block the Node event loop or Unreal rendering on scientific calculations.
- Keep credentials, regenerable caches/build output, model weights and large acquired data out of Git. Preserve the existing Unreal source assets/LFS workflow and Cesium-token ignore rules.
- Use Context7 `resolve-library-id` followed by `query-docs` for current library/framework/API/CLI/cloud documentation when available. If unavailable, use primary official documentation and state that limitation when material.
- Recurring tasks require a reachable stop condition and must stop when no authorized work remains. No recurring tasks are part of this starter.
