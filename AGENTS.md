# Repository guidance

## Architecture

- `apps/api/`: Node/TypeScript validation, queue, lifecycle and client gateway.
- `services/models/`: Python model workers; stdout is a machine-readable manifest, diagnostics go to stderr.
- `packages/contracts/`: canonical JSON Schemas and wire types.
- `clients/unreal/`: client track; an actual engine project is not included initially.
- `docs/`: architecture, API, evidence rules, resources, Unreal integration and roadmap.

## Evidence and scope

- Preserve `illustrative`/`synthetic` labels until real adapters are implemented and validated.
- Unsupported domains must have a reason; never substitute zero or fabricate a map.
- Keep all requested domains in scope, including noise, water quality, household bills, labor rates and population growth.
- STRATA recursion is not evidence for accurate decades-ahead forecasts. Each metric needs its own validated horizon and uncertainty.
- Water use, net consumption, quality and scarcity are separate outputs. Local jobs, labor-force rates and population are separate quantities.
- Do not infer facility attribution from nearby satellite changes alone.

## Engineering

- Run `npm run check`; use focused meaningful checks for changed behavior.
- Keep schema/type/Python validation/API/client docs aligned on changes.
- Do not block the Node event loop or Unreal rendering on scientific calculations.
- Keep credentials, generated Unreal assets, model weights and large data out of Git.
- Use Context7 `resolve-library-id` followed by `query-docs` for current library/framework/API/CLI/cloud documentation when available. If unavailable, use primary official documentation and state that limitation when material.
- Recurring tasks require a reachable stop condition and must stop when no authorized work remains. No recurring tasks are part of this starter.
