# Environmental evidence and model refinements

This local extension addresses evidence coverage, additive screening calculations and clearer dashboard/3D presentation. The existing trend, NEX-GDDP ensemble, HighResMIP agriculture, Gaussian plume and wind models remain available.

## Challenge alignment

The [official challenge](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/) asks for regional variables, time-series visualization, rates of change and significance testing. Its Resources tab lists Giovanni, Hydrology Time Series, AppEEARS and NOAA CDO, among other sources. The new regional panel displays 2003–2025 NASA POWER histories with the existing Python trend engine's reports. Model scenarios are kept separate from these historical trend tests.

## Additional NASA future data

[NASA POWER's Projection API](https://power.larc.nasa.gov/docs/services/api/projection/) supplies monthly NEX-GDDP-CMIP6 ensemble simulations on a 0.25° regional grid. The new prepared products contain three distinct pathways (SSP1-2.6, SSP2-4.5 and SSP3-7.0), 2015–2100. They complement the existing five-model SSP2-4.5 / SSP5-8.5 period summaries. No pathway is silently substituted for another.

`node scripts/fetch-power-projections.mjs` acquires bounded products for the five sites. `apps/web/js/power-projection.js` validates the source units and calendar, preserves missing months, weights annual temperature by month length, and sums precipitation rates over actual calendar days. Every annual number requires all twelve months. This response supplies ensemble output without an uncertainty interval; its interannual variation is simulated climate variability, not a prediction of weather in that particular year. Hot-day counts are not inferred from monthly mean maximum temperatures.

The main Heat and Water tabs offer **Yearly simulation** and **Climate periods**. Their exact-value tables and 3D callouts use the same source values. Regional scenarios do not isolate a facility's additional heat or withdrawals.

## Historical evidence and source coverage

- `python -m services.models.trends.export_web` prepares real bundled POWER histories, source metadata and Python statistical reports. `--giovanni-dir PATH` imports independently verified Giovanni exports. The 25 exports described in the team research notes are absent from this checkout, so they are shown as unimported, not reconstructed from prose.
- Groundwater units must come from the source export. A storage percentile must not be labelled millimetres or a river/groundwater level.
- `node scripts/prepare-site-evidence.mjs` prepares OSM/EPA identity candidates and bounded USGS station records. The five site audits include 2025 daily mean discharge from representative gauges. The UI preserves station coordinates, source units, dates, qualifiers and source hashes.
- A nearby EPA record is a candidate until documentary identity review. A confirmed operator affiliation does not establish that a reporting record describes the selected campus. Identity alone is not evidence of causal environmental impact.
- Gauges are measurements at their own locations. They are not automatically connected to a facility intake or discharge. Annual gauge means require at least 90% of calendar days; future selections never reuse them as future observations.

## New conditional local scenarios

The additive `environment-screening` Node job runs `services/models/screening/worker.py`. The guided workbench accepts explicitly sourced or assumed annual inputs; fields begin empty. It can return an actionable input checklist without inventing facility parameters. Advanced JSON supports multiple supplied years and separate source groups.

- **Heat and air:** scale actual NASA GEOS-FP dilution fields using supplied sensible heat or emission rates. Sensible heat is not electrical capacity. Passive-tracer heat omits buoyancy and urban/cooling physics; air screening omits chemistry and future meteorology.
- **Water:** supplied withdrawal/return accounting and conservative complete mixing of temperature or one named constituent. These calculations do not predict aquifer depletion, river morphology or water scarcity.
- **Noise:** sound-power-based free-field receptor levels, energetic addition of supplied background and optional chosen-level contours. Sound power differs from measured receptor sound pressure. Contours are comparison levels, not legal or health thresholds.
- **Agriculture:** the existing climate-exposure model is retained. Crop yield, forest mortality and pollution-dose responses remain unavailable without suitable calibrated response models.

See [equations, source references and limits](environment-screening.md). No scientific predictive validation is claimed from passing software tests.

## 3D presentation and performance

Local heat/air scenario rasters use the actual wind-based source grid and a scale fixed across the supplied scenario years. Noise contours use only calculated supported radii. Water markers show source-dated measured gauges. Missing scenario years do not inherit earlier outputs. No river reshaping or vegetation mortality is invented.

Model text is rendered at CSS resolution, so adaptive WebGL quality does not blur the numbers. Placement avoids the sidebar, neighborhood controls and timeline. Only camera/value changes trigger text layout; source overlays and markers have bounded lifecycles.

## Other model research

The [official IBM/NASA Prithvi model card](https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-2.0-300M) describes a foundation model using multiband HLS imagery. Applying it here would require suitable inputs, a downstream task/head and local validation. No weights were installed or existing model replaced, and no generic image model is presented as a validated future facility-impact model.

## Verification

Run `npm run check` and `npm run web:build`. Source acquisition is separately reproducible with the scripts above. Live screening jobs require the Node/Python service started by `npm run web`; prepared historical and climate products remain available in static builds. Credentials, raw source caches and weights remain outside Git.
