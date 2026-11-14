# Shared contracts

- `schemas/scenario.schema.json`: canonical accepted JSON structure and numeric demo guardrails (draft-07).
- `schemas/result.schema.json`: illustrative worker output contract, validated by Node before success is reported.
- `src/index.ts`: TypeScript wire types, lifecycle envelope, and domain registry.

Node uses Ajv plus ordering/span checks. Python defensively validates its own stdin so it can also be invoked directly. Keep both aligned when evolving this contract. API integration tests execute the actual Python worker and check the returned schema/provenance. Bump `schemaVersion` and update all clients if a wire field changes incompatibly.

An accepted year range does not establish a scientifically supported forecast horizon. `mode: illustrative` is the only implemented mode. No live-data or validated forecast mode is silently substituted.

Future geospatial layers require an explicit schema for URLs, bounds, CRS, resolution, time, units, nodata and source attribution. The current result schema deliberately requires an empty `layers` array.
