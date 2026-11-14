# Contributing

Start with [README](README.md), [architecture](docs/architecture.md), [modeling rules](docs/modeling.md), and [roadmap](docs/roadmap.md). Use a focused branch/PR and describe the resulting behavior, validation and evidence limitations.

## Local workflow

1. Install Node 24.12+ and Python 3.11+; run `npm ci`.
2. Run `npm run check` before proposing changes. Python model tests use `python`; see README for alternate executables.
3. For wire changes, update JSON Schemas, TypeScript types, Python validation, examples, API docs, clients and integration tests together.
4. Keep credentials, large source downloads, checkpoints and generated Unreal files out of Git. See [data conventions](data/README.md).
5. Document sources and licenses for every acquired dataset. Add links and access notes to [resources](docs/resources.md).

## Scientific contributions

- Do not replace missing measurements with invented values. Clearly label any synthetic fixture.
- Do not relabel illustrative accounting as a validated forecast.
- Distinguish water use from consumptive loss; emissions inventories from concentrations; facility tariffs from household rates; jobs from unemployment rates; detailed visuals from measurement resolution.
- Supply calibration and held-out validation before enabling a scientific output. Label sensitivity ranges correctly.
- Noise, water-quality, hydrological and socioeconomic adapters need domain evidence, not only a new model field.

No project license is selected yet. Contributors should preserve existing attribution and avoid adding third-party code or data without an appropriate, documented permission basis.
