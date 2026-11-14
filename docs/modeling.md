# Modeling, evidence, and limits

This is an implementation plan for the scientific and socioeconomic modules. It is not a declaration that these modules already work. See [the resource catalog](resources.md) for sources and access boundaries.

## What the starter actually does

The runnable demonstration performs illustrative accounting for electricity use, grid-emissions inventory estimates, cooling-water **use**, and a simple facility electricity-energy bill. Its inputs are synthetic. It has no live data adapters, calibrated environmental model, uncertainty model, household-tariff model, labor/population model, acoustic model, or STRATA integration.

The actual evidence vocabulary in the starter is:

| Field | Current value | Meaning |
| --- | --- | --- |
| Result `mode` | `illustrative` | Demonstration calculations, not a validated forecast. |
| `provenance.kind` | `synthetic` | Inputs are invented demonstration assumptions, not observations of a real facility. |
| Metric `status` | `illustrative` | The value is suitable for demonstrating the software contract only. |
| `uncertainty.status` | `not_quantified` | No statistical interval or validated uncertainty propagation is implemented. |
| `unavailable` | Unsupported-domain entries | The system reports missing capabilities instead of fabricating environmental or community outcomes. |

These labels must survive the API, saved results, charts, and Unreal presentation. A plausible number or a detailed map does not change its evidence class.

## Future evidence vocabulary

When validated adapters are introduced, propose and version an expanded contract rather than silently reinterpreting the starter's labels:

- **Observed:** measured data with instrument/station identity, units, quality flags, dates, and provenance.
- **Derived:** a transparent calculation from documented inputs.
- **Forecast:** a model prediction within a tested forecast horizon.
- **Scenario:** a conditional result under stated future assumptions.
- **Unsupported:** no suitable data/model, accompanied by a reason.

These are proposed future evidence classes. They are not additional implemented result modes in the starter.

## Long-range projections

STRATA repeatedly predicts the next atmospheric state. The ability to feed its output back into itself does **not** establish decades-ahead accuracy. Its paper reports stable 24-hour global rollouts and increasing large-scale biases with lead time. Keep STRATA an optional short-range research adapter, separate from the long-range impact engine. Sources: [STRATA paper](https://arxiv.org/abs/2606.31248), [model card](https://huggingface.co/nvidia/strata).

For long-range climate inputs, evaluate [NASA NEX-GDDP-CMIP6](https://www.nccs.nasa.gov/data-collections/nex-gddp-cmip6/) and its [dataset paper](https://ntrs.nasa.gov/citations/20240011616). The archive includes climate projections through 2100 at approximately 25 km grid spacing. This does not validate local 2100 water quality, electricity bills, employment, or population. Each downstream module needs its own supported horizon, calibration, assumptions, spatial scale, and uncertainty.

Do not resample a coarse climate input into a detailed-looking grid and describe the result as building-scale evidence. Long-range results should describe conditional changes and risks, not the exact weather or noise at a future date.

## Domain implementation requirements

### Energy and electricity consumption

Start from an explicit definition of facility capacity, IT load, utilization, time resolution, and power usage effectiveness (PUE). PUE relates total facility energy to IT equipment energy; a capacity that already represents total facility demand must not be multiplied by PUE again. Keep average energy and peak demand separate. Source: [DOE/Berkeley Lab data-center energy-use report](https://www.energy.gov/documents/united-states-data-center-energy-usage-report-2025-update).

The starter demonstrates assumed-input accounting only. Future implementations should use operator/utility records where available, document load profiles and efficiency changes, and distinguish forecast demand from a user-selected growth scenario.

### Emissions and air quality

Keep onsite generator emissions separate from electricity-related emissions at power plants. [EPA eGRID](https://www.epa.gov/egrid) provides historical US generation and emission-factor information, useful for inventory estimates. A regional average factor is not a model of which generators respond to a new data-center load.

Air-pollutant emissions are not the same quantity as ambient concentrations. Concentrations need meteorology, transport, dispersion/chemistry, background pollution, and validation. [GEOS-CF](https://gmao.gsfc.nasa.gov/gmao-products/geos-cf/) provides regional composition context and short-range forecasts; it does not identify a data center's causal contribution. Satellite NO2 products must retain their column/surface definitions rather than being presented directly as street-level exposure. Sources: [GEOS-CF FAQ](https://gmao.gsfc.nasa.gov/gmao-products/geos-cf/faq_geos-cf/), [NASA guidance on OMI column NO2](https://forum.earthdata.nasa.gov/viewtopic.php?t=6400).

This starter does not calculate validated NO2, PM2.5, AQI, exposure, or health/ecosystem damage.

### Water use and availability

Distinguish **withdrawal**, **consumptive loss**, and **return flow**. Record the source watershed/aquifer or utility, the location of returns, seasonal flows, competing demands, and groundwater/storage dynamics. Water use cannot be converted directly into river-level decline. The [USGS data-center assessment](https://pubs.usgs.gov/publication/sir20265035/full) discusses cooling, water-availability differences, reporting uncertainty, and the importance of local conditions.

Water usage effectiveness (WUE) describes site water use relative to IT equipment energy, with the definition and units recorded. The starter's cooling-water-use estimate is not automatically evaporative consumption, potable-water withdrawal, or watershed depletion. Sources: [DOE cooling-water guidance](https://www.energy.gov/cmei/femp/cooling-water-efficiency-opportunities-federal-data-centers), [USGS assessment](https://pubs.usgs.gov/publication/sir20265035/full).

A future water-balance/hydrological adapter must model the actual water source and its connections, rather than subtracting an annual site-use total from an arbitrary visible lake on the globe.

### Water quality

Require monitoring and discharge information: quantities, temperature, chemistry, treatment, release location, and receiving-water conditions. Model dilution, transport, and reactions only where the selected model and observations support them. Cooling-water use by itself does not establish contamination or ecological damage. Sources: [EPA water-quality data overview](https://www.epa.gov/waterdata/water-quality-data), [USGS data-center water discussion](https://pubs.usgs.gov/publication/sir20265035/full).

Implement upstream/downstream comparisons with sampling dates, detection limits, units, and quality metadata. Review the [Water Quality Portal freshness warning](resources.md#water-quality-portal-freshness-warning) before claiming that a water adapter contains recent observations.

### Electricity bills

Keep the facility's bill separate from household/customer-class bills. A facility bill may involve energy charges, demand charges, fixed charges, and a special tariff or contract. Community-bill scenarios additionally need assumptions about generation costs, investments, regulation, and allocation of system costs. Growing demand alone cannot establish the direction or magnitude of a household bill change. Source: [DOE large-load rate design brief](https://www.energy.gov/policy/articles/electricity-rate-designs-large-loads-evolving-practices-and-opportunities).

The starter demonstrates only an assumed energy-price calculation for the facility. It does not model full tariffs or household bills. Future monetary outputs must declare currency, price year, nominal versus inflation-adjusted values, applicable tariff, and supported horizon.

### Employment and unemployment

Separate temporary construction employment, permanent operating employment, local residents, commuters, and any indirect-job assumptions. A job count is not an unemployment-rate model. In the US BLS definitions, the unemployment rate uses the labor force as its denominator; the employment-population ratio uses the relevant population. Other jurisdictions' definitions must be recorded explicitly. Source: [BLS concepts and definitions](https://www.bls.gov/cps/definitions.htm).

Future scenarios need a regional labor-force baseline, participation, sectoral trends, commuting, hiring assumptions, and migration. Do not subtract proposed jobs directly from population or assume all jobs are filled by previously unemployed local residents. This module is unavailable in the starter.

### Population

Use a suitable local demographic baseline and explicit fertility, mortality, and migration assumptions. Cohort-component projections advance population groups using these components; national projections do not automatically describe a neighborhood. Source: [Census projection methodology](https://www.census.gov/programs-surveys/popproj/about.html).

Any link between jobs, costs, environmental conditions, and migration must be justified with an estimated relationship or declared as a scenario assumption. Do not let a data-center capacity slider silently determine population growth. This module is unavailable in the starter.

### Land conditions and ecosystems

Use quality-controlled time series for land cover, vegetation, and surface temperature. Surface temperature is not the same variable as air temperature, and habitat indicators are not direct measurements of ecosystem damage. [Landsat science products](https://www.usgs.gov/landsat-missions/landsat-science-products) provide relevant observational entry points. Site construction, regional urbanization, climate, seasonality, and other land changes require comparison and attribution work.

This module is planned. Do not label a rendered vegetation or terrain change as a calculated ecological outcome unless the relevant model supplies it.

### Noise pollution

Collect equipment sound-power data and spectra where available, operating schedules, measured background sound, receptor locations, terrain/buildings, and proposed mitigation. Distinguish cooling operation, generator testing, emergency operation, and construction. Assess combined existing and proposed sources, and document assumptions and measurement/model uncertainty. Sources: [Environment Agency noise-modeling requirements](https://www.gov.uk/guidance/noise-impact-assessments-involving-calculations-or-modelling), [industrial-noise assessment guidance](https://www.gov.uk/government/publications/noise-and-vibration-management-environmental-permits/noise-and-vibration-management-environmental-permits).

Use an appropriate acoustic propagation method, calibrate against ground measurements, and preserve each indicator's weighting and averaging period. Sound contributions must be combined with an acoustic method, not an arithmetic average of decibel values. Assessment criteria must match the jurisdiction and receptor type; the linked UK guidance is not a global threshold. Satellite imagery can provide geographical context but does not supply measured environmental sound levels.

The starter has no acoustic model. Noise maps, receptor estimates, and future changes remain unavailable until suitable inputs and a validated adapter are added.

## Coupling and attribution

- Map facilities to relevant airsheds, watersheds, electricity service areas, and labor/census regions. These boundaries differ.
- Use a common scenario ID, calendar, units, parameter provenance, and shared driver definitions. Avoid counting the same electricity, water, jobs, or emissions in multiple modules.
- Compare expansion and mitigation scenarios with an explicitly defined baseline. Label the difference as a modeled scenario contribution, not automatically a measured causal effect.
- Historical before/after differences require consideration of weather, seasonality, traffic, other industry, construction, and broader regional trends.
- Terrain/facility edits in Unreal remain visual until they change a supported numerical input and the affected models are rerun.

## Validation and uncertainty gates

Before promoting an adapter beyond illustrative status:

1. Record input datasets, licenses, geographic resolution, time coverage, units, quality rules, and data gaps.
2. Specify the numerical method, parameter sources, model/version, supported geography and horizon, and relevant evaluation metrics.
3. Backtest on held-out dates/locations where suitable observations exist. Compare against a meaningful baseline rather than only checking that code runs.
4. Distinguish parameter sensitivity, alternative scenarios, model spread, and statistical uncertainty. A low/central/high sensitivity range is not automatically a confidence interval.
5. Preserve missing-data and unsupported-model states in saved results and the Unreal UI. Never substitute zeros for unknown pollution, unemployment, water quality, or noise.
6. Document limits and propagate uncertainties through coupled models where defensible. Until implemented, retain `uncertainty.status = "not_quantified"`.

Trend-analysis work also needs declared aggregation, seasonal treatment, missing-data rules, serial-correlation handling, effect-size units, and multiple-testing rules when mapping many locations. A small p-value does not identify the source of a change.

## Suggested implementation order

1. Choose one region with accessible facility, utility, environmental, labor, and demographic records.
2. Replace synthetic accounting inputs with documented observations without changing their meaning.
3. Add historical environmental trends and meaningful significance checks to satisfy the challenge's evidence focus.
4. Integrate calibrated air-quality, hydrology, water-quality, and acoustic models independently.
5. Add local tariff, labor, and population scenario modules with explicit economic/demographic assumptions.
6. Couple shared drivers and uncertainty methods, retaining unavailable results wherever data or validation are insufficient.
