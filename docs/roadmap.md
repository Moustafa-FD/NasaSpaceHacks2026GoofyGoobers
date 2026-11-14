# Implementation roadmap

> **Archived starter roadmap:** the stage table and suggested tasks below are historical planning, not the current completion status or backlog. The repository already includes the team's [web/NASA/statistics workflow](../apps/web/README.md) and [Unreal project](../clients/unreal/README.md), alongside the environmental gateway described in [Data and backend](data-and-backend.md) and [the current API](api.md). Current scope is environmental, including agriculture; bill, employment/labor and population stages are out of scope. Use the active handoff for Part 2 integration and preserve the existing client/data pipeline.

This roadmap separates demonstrated behavior from planned scientific capability. No stage is completed merely because a folder or resource link exists.

| Stage | Work | Completion evidence |
| --- | --- | --- |
| 0 - Local foundation | Node API, shared contracts, Python accounting, status/events/results, synthetic fixtures | `npm run check` and `npm run demo` pass; all outputs labeled illustrative |
| 1 - One historical investigation | Select a pilot cluster; connect facility records plus one NASA variable; normalize quality-controlled series | Reproducible acquisition/provenance, missing-data report, trend magnitude/significance and comparison-region analysis |
| 2 - Unreal client | Create actual engine project, Cesium globe, HTTP/WS connector, charts and scenario editor | Run submission/reconnect/failure checks in [Unreal guide](unreal-integration.md); no unsupported layers fabricated |
| 3 - Energy and demand scenarios | Replace fixed factors with sourced load, efficiency, cooling and grid pathways | Historical calibration/held-out checks, supported horizon, sensitivity and units documented |
| 4 - Air, water and noise | Add separate atmospheric, watershed/groundwater, water-quality and acoustic models | Each adapter has observations, source/receptor boundaries, calibration, validation metrics and uncertainty; ground monitoring where needed |
| 5 - Bills and community | Facility tariff model, separate household-bill model, labor and population modules | Customer-class cost allocation, labor-force denominators, commuting/migration and demographic assumptions documented |
| 6 - Coupled long-range scenarios | Coordinate climate, operating, infrastructure and demographic pathways, including 2030/2050 and exploratory 2100 cases where supported | Compatible baseline/intervention runs, propagated uncertainty, explicit metric-by-metric horizon; no extrapolated accuracy claims |
| 7 - Shared deployment | Durable jobs/database, versioned cache, object/layer storage, access control and HTTPS/WSS | Restart recovery, isolation, resource limits, monitoring, provider-term review and reproducible deployment |

Suggested first team split: backend/data engineering, scientific/domain modeling, and Unreal interaction/visualization. Select only evidence-backed pilot outputs for the hackathon demonstration; keep the full domain registry to guide later expansion.

## Definition of done for a model adapter

1. State the scientific question, geographic scale, horizon and output units.
2. Supply permitted input data and acquisition/provenance records.
3. Define an explicit baseline and intervention inputs.
4. Test numerical behavior and document calibration/held-out validation.
5. Return source/model versions, evidence class, uncertainty and missing-data flags.
6. Register capability and supported horizon; unavailable results stay unavailable.
7. Add corresponding API/contract tests and an Unreal display definition.

## Open decisions

- Pilot geography, verified facilities, commissioning dates and available operating records.
- Exact Unreal Engine/Cesium version and target hardware.
- Which live observation and scientific model adapters the team can validate first.
- Local tariff/regulatory jurisdiction, labor/census units and acoustic assessment method.
- Code license and dataset redistribution policy.
- Hosting/resources only after the local workflow and target models are verified.
