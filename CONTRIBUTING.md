# Contributing

Start with [README](README.md), the [Part 1 handoff](docs/data-and-backend.md) and [active Node API](docs/api.md). The existing [web team guide](apps/web/README.md) covers the separate browser/NASA/Unreal workflow. Preserve that work while adding the environmental backend; changing one service does not automatically connect the other.

## Local workflow

1. Install Node 24.12+ and Python 3.11+ available as `python`; run `npm ci`, then **`npm run data:setup` before `npm run check`**. Setup creates `.venv` and installs NumPy/numcodecs for the compressed POWER data helper.
2. Run `npm run check` before proposing changes. It checks TypeScript, active source/API/job fixtures, Python data-helper fixtures and retained accounting regressions. Windows/Linux CI performs dependency setup first; live NASA/provider acquisition is not part of these offline checks.
3. Start `npm start` for the environmental API at `http://127.0.0.1:3000`. In another terminal use `npm run data:sync`, then `npm run demo` for cached POWER series. Optional `npm run data:expand` acquires bounded inventories, North American examples and a USGS station example; inspect its report instead of assuming every source succeeded.
4. Optional `npm run data:verify` / `npm run data:verify-expanded` check acquired data through the running API and save ignored verification receipts. Provider quotas, source publication delays and missing data still apply; fixture tests and live plumbing checks do not validate predictive skill.
5. For wire changes, update `packages/contracts/src/environment.ts`, runtime validators, adapters/workers, examples, API/client docs and meaningful tests together. Ground imports receive additional structural validation. Old scenario/result JSON Schemas are inactive fixture contracts, not the accepted environmental API.
6. Keep credentials, large downloads, caches/results, checkpoints and generated Unreal files out of Git. The [data conventions](data/README.md) distinguish the committed `cloudshadow/` demo data from ignored Node source caches. Document source versions, access terms, license, units, quality rules, hashes and actual coverage.

`DATA_PYTHON_EXECUTABLE` explicitly selects a Python with the data requirements installed; otherwise the helper uses `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere, then `PYTHON_EXECUTABLE`/`python`. Activation is unnecessary for the helper. Set `PYTHON_EXECUTABLE` before setup to choose its base Python. The retained `test:models` script still invokes `python` on PATH. Separate NASA web-pipeline dependencies, such as Pillow, are documented in the web guide and are not all installed by `data:setup`.

## Service compatibility

`npm start` now serves environmental `/v1` requests with file-persisted jobs/results. `npm run demo` now requires acquired POWER cache; old accounting scenario bodies are rejected. The Python accounting worker/schemas remain regression fixtures, with no socioeconomic output exposed by the environmental API.

`npm run web` retains the browser product and `/api` service on port 8765; web build/preview and NASA/Unreal export commands remain available. Both Node servers read `PORT`, so use distinct values when running together. No web-to-`/v1` proxy, browser CORS integration or automatic `cloudshadow`/environment-cache mapping is implemented. Static GitHub Pages hosting does not run either Node API.

## Scientific contributions

- Keep observed station records, reported emissions inventories, model-derived fields, climate simulations and user-supplied evidence distinct. Preserve synthetic labels on fixtures and never fill unavailable measurements with invented values or zero.
- Preserve existing web statistics and source methodology. Integrating them into the Node job contract requires explicit input/reference mapping and appropriate numerical/source validation.
- Keep source facility identities separate. OSM elements can duplicate a campus; regulatory sector candidates are not automatically verified data centers. Nearby changes do not establish facility causation.
- Retain native cadence/resolution, source coordinates/datum, units, nulls, qualifiers, censoring, methods and provenance. Emissions are not concentrations; rain/reference ET0, water withdrawals, soil moisture and water chemistry differ.
- Agricultural climate exposure is not calibrated yield, suitability or pollution damage. Model spread is not a confidence interval. Source-specific horizons and uncertainty must remain explicit.
- Supplied acoustic/water/crop/vegetation imports are not independently verified. Do not average dB arithmetically, substitute censored results or infer crop yields from vegetation proxies.
- Preserve Open-Meteo public non-commercial service terms/CC BY attribution, OSM ODbL obligations and other source permissions. No project code license is selected; document an appropriate permission basis before adding third-party code/data.

Use a focused branch/PR describing resulting behavior, evidence, tests and practical limits. Do not claim deployment, acquired coverage or predictive accuracy from a resource link or source-code presence alone.
