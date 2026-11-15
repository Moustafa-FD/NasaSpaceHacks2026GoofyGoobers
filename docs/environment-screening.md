# Explicit-input environmental screening

The additive `environment-screening` Node job runs `services.models.screening.worker`. It retains all existing climate, plume, trend and agricultural-exposure models. The new models calculate conditional scenarios only when their required inputs and source citations are supplied. They do not infer a facility's operating parameters from its building size, a satellite trend or another facility's records.

Every result is labelled `screening-scenario`, with `uncertainty.status = "not_quantified"`. These are uncalibrated screening calculations, not demonstrated predictive accuracy, regulatory assessments or proof of facility attribution.

## API and missing inputs

Submit through the existing `POST /v1/runs` asynchronous API. For example, this intentionally incomplete request returns the input checklist without fabricating any values:

```json
{"schemaVersion":"1.0","kind":"environment-screening","siteId":"colossus1","years":[{"year":2035}]}
```

`siteId` selects one of the five study sites; alternatively provide `point: {latitude, longitude}`. `years` contains 1–81 distinct explicitly supplied years within 2020–2100. This input range is a scenario arithmetic guardrail, not a validated prediction horizon. Missing years are not interpolated or extrapolated. All numeric inputs must be finite numbers; missing inputs are omitted rather than set to zero.

Each annual input record containing numbers requires `source: {evidence: "reported" | "assumed", citation, url?}`. A citation must identify the evidence and its accounting/operating assumptions. `reported` is a caller-provided provenance classification, not independent verification. The result exposes all citations and flags whether any assumptions are present. Dispersion parameters and optional background noise have their own citations.

The complete typed request and input registry are in `packages/contracts/src/screening.ts`. Outputs contain `years[].metrics`, `years[].noiseContours`, `requiredInputs`, `inputSchema`, `sources`, `references`, `limitations` and optional `spatial` transport products. Unknown quantities have no metric, with actionable missing-input reasons. An actual zero remains zero.

## Heat and air: a retained NASA transport footprint

Provide `dispersion: {effectiveHeightM, landUse, source}`. For study sites the worker reuses the existing Gaussian plume model and committed NASA GEOS-FP wind samples; other points use the existing bounded point-extraction workflow. No existing wind or plume model is replaced.

- Air requires an annual `emissionRateGs` and `pollutant`. Source-only primary concentration is `chiOverQ × emissionRateGs × 1,000,000` in µg/m³. The existing Gaussian ground-reflection formulation and its approximately 100 m–10 km downwind range are retained. A yearly source pathway changes the stated emission input; it does not forecast the future wind, background pollution or chemistry.
- Heat requires annual sensible heat release `heatMw` plus explicit `dispersion.airDensityKgM3` and `dispersion.specificHeatJkgK`. The passive-tracer approximation is `deltaT = chiOverQ × heatMw × 1,000,000 / (rho × cp)`, yielding K, numerically equal to a °C temperature difference. This follows sensible-energy conservation and the existing scalar-dilution factor. It is **not** a validated urban or cooling-tower heat model: buoyancy, plume rise, latent heat, downwash, radiation and heat storage are omitted. Large heat perturbations are particularly unsuitable for this passive approximation.

`spatial.dispersion` preserves the actual source grid, wind-sample coverage, receptors and assumptions. `spatial.scales[]` provides the explicitly supplied annual `heatMultiplier` and `airMultiplier`; clients may scale finite grid values for the selected supplied year while preserving missing pixels. Grid spacing is a display sampling interval, not independently established predictive resolution.

References: [EPA Gaussian plume formulation](https://www.epa.gov/system/files/documents/2022-05/402-r-00-004.pdf) and the existing [plume methods](projections.md). The passive thermal scaling is an explicitly stated idealization based on energy conservation, not an EPA-endorsed facility heat model.

## Water: accounting and conservative complete mixing

`withdrawalM3s` and `returnM3s` are **annual-average scenario rates**, not peak permitted rates. Annual totals multiply each by that calendar year's seconds, including leap years. Their difference is reported as **withdrawal minus return (accounting)**. The figures must use the same facility boundary. This does not predict aquifer storage, lake evaporation, water stress or river-level change; returns may have different timing and source-water boundaries.

For receiving-water mixing provide `riverFlowM3s` (flow immediately upstream of the discharge) and `returnM3s` (effluent discharge flow). With upstream value `Cr` and discharge value `Ce`, the steady, completely mixed result is `(Qr × Cr + Qe × Ce) / (Qr + Qe)`:

- `upstreamTempC` and `dischargeTempC` yield mixed temperature under equal water density/heat capacity and no heat exchange.
- `upstreamMgL`, `dischargeMgL` and `pollutant` yield a conservative constituent concentration. Both inputs must describe the same substance and units. No pH mixing, reactions, oxygen demand, decay or ecological effects are modeled.

Zero combined flow has an undefined mixed value and stays unavailable. No values are spatially propagated downstream and no river geometry is changed. Reference: [EPA NPDES Permit Writers' Manual](https://www.epa.gov/npdes/npdes-permit-writers-manual), chapter 6, complete-mixing mass balance. This implementation is not a permit-limit calculator.

## Noise: free-field point-source screening

Provide annual `soundPowerDbA` (**sound power**, dB(A) re 1 pW) and named `receptors: [{name,distanceM}]`. A measured sound-pressure value cannot be supplied as sound power without conversion and appropriate source information. The omnidirectional spherical free-field model is `Lp = Lw − 10 log10(4πr²)`. It decreases by approximately 6.02 dB per distance doubling. Receivers must be acoustically in the source's far field, within the supported display range 1–10,000 m; distance alone cannot establish far-field validity for a large campus.

Optional sourced `backgroundNoise: {dbA,source}` is added energetically as `10 log10(10^(Lp/10) + 10^(Lb/10))`, never by adding decibel numbers. Background should use a compatible acoustic indicator and time period. This is not an Lden or occupational exposure calculation.

Optional `noiseContourLevelsDbA` contains 1–5 unique chosen display levels from 10–140 dB(A). Source-only radii are `sqrt(10^((Lw−level)/10)/(4π))`. These are **chosen scenario contours, not legal or health limits**. Radii outside 1–10,000 m are unavailable rather than clamped. No contours are generated implicitly. Reflections, barriers, buildings, terrain, frequency-dependent attenuation, weather and multiple equipment locations are not modeled; this is not ISO 9613 or a calibrated campus model.

References: [OSHA acoustical fundamentals](https://www.osha.gov/otm/section-3-health-hazards/chapter-5) and [FHWA sound propagation/decibel addition](https://www.fhwa.dot.gov/environment/noise/noise_barriers/design_construction/design/design03.cfm).

## Agriculture and scientific validation

The existing `agriculture` job remains the supported complete-season climate-exposure workflow. Crop yield, forest mortality and pollution dose-response remain explicitly unavailable; neither this worker nor a generic pretrained model establishes those capabilities without the required observations, parameterization and validation.

Tests check independent hand calculations, dimensional conversions, leap-year totals, conservative mixing, distance doubling, energetic sound addition, zero versus missing, sourced-input validation, missing years, retained NASA transport products and the actual Node/Python job protocol. These tests verify implementation behavior, not real-world forecast skill. Monitor calibration, held-out validation and uncertainty quantification remain necessary before these scenario outputs support facility-impact claims.
