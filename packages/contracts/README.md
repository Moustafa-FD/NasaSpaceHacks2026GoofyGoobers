# Shared environmental contracts

[src/environment.ts](src/environment.ts) contains the active discriminated `EnvironmentRequest`, `EnvironmentRun`, runtime validator and capability registry. [The API documentation](../../docs/api.md) describes exact fields, source bounds, examples and outputs.

Requests use `schemaVersion: "1.0"` and one `kind`: POWER `sync`/`series`/`grid`; `facilities-sync`; `emissions-sync` (`npri` or `epa-nei`); point `air-quality`/`land-water`/`climate`; station `water-quality`; `agriculture`; or `ground-evidence`. Ground records receive [additional structural validation](../../apps/api/src/environment/ground-evidence.ts).

Runs retain submitted `request`, status/progress, stage/details, timestamps and terminal error/result path. WS messages are `{type:"run.status",run:...}` with an immediate latest snapshot, not durable replay. Initial persistence failures do not accept work; a terminal `RUN_PERSISTENCE_FAILED` state can be memory-only.

Result shapes depend on the operation. Preserve source-native units/cadence/resolution, source identity, model/observation/report/import evidence, source/requested/valid coverage, nulls, quality flags and provenance. Facility maps, annual inventory mass, ambient concentration and climate exposures are distinct contracts, with no automatic source identity matching. Native grid JSON is not a tile-serving contract.

Agriculture results are climate-exposure indicators, not yield/suitability predictions or facility attribution. Current climate access stops at 2050-01-01 and offers no selectable SSP. USGS station records retain source units/times, approval/qualifier/method metadata, censoring and bounded actual station coverage. They do not establish universal water chemistry or facility causation. Supplied ground records remain not independently verified; no external reference URLs are fetched or decibel values averaged.

## Inactive legacy accounting contracts

`schemas/scenario.schema.json`, `schemas/result.schema.json` and `src/index.ts` describe the original synthetic accounting fixture and regression protocol. They are **not accepted active environmental requests**, despite sharing a `1.0` version label. Their economic domains and empty-`layers` constraint do not define current environmental outputs.

Keep active types/validators, adapters, source examples, workers, API/client docs and tests aligned. Version incompatible wire changes. A valid requested date does not prove finite source data exists or validate a predictive horizon. Future map layers need a separate CRS/bounds/resolution/units/nodata/time/attribution/retention contract.
