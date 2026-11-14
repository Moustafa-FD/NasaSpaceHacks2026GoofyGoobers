# Resource catalog

Reference date: **2026-11-14**. These resources support the implementation plan; a link in this catalog does not mean that an adapter, dataset download, scientific model, or account integration is implemented.

## Verification and integration status

- The 13-item challenge catalog below was read from the rendered official Resources tab during project research. Its URLs and descriptions are recorded from that page. **Each destination was not independently opened, authenticated, or tested.**
- The supplementary methodology pages identified below were consulted during research. This verifies the cited description, not the availability of every dataset, API, account entitlement, or software dependency.
- The starter runs on **synthetic illustrative inputs only**. It does not call live NASA, utility, census, labor, acoustic, or water-quality services.
- Recheck product versions, coverage, quality flags, authentication, quotas, attribution, and licenses before implementing an adapter. Do not place account credentials in Git or the Unreal client.

## Official challenge resources

Source: [Earth System Trend Detective - Resources](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/?tab=resources).

| Resource listed by the challenge | Planned use | Boundary for this project |
| --- | --- | --- |
| [Giovanni](https://giovanni.gsfc.nasa.gov/) | Explore variables, produce regional time series, and export values. | Historical analysis is not a facility-attribution model or a long-range environmental projection. Check the legacy and cloud service documentation separately. |
| [Hydrology Time Series](https://disc.gsfc.nasa.gov/information/tools?title=Hydrology%20Time%20Series) | Obtain hydrological time series for regional context. | A hydrological observation does not directly establish an individual facility's water use. |
| [AppEEARS](https://appeears.earthdatacloud.nasa.gov/) | Extract point/area time series, including land-surface temperature and vegetation products. | Check each product's quality flags, scale, resolution, and authentication requirements. |
| [NOAA Climate Data Online](https://www.ncei.noaa.gov/cdo-web/) | Compare historical station weather with regional satellite-derived trends. | Station coverage and record completeness vary. |
| [SeaWiFS time-series and significance paper](https://ntrs.nasa.gov/api/citations/20090042747/downloads/20090042747.pdf) | Study a worked scientific example of time-series analysis and significance testing. | Its subject is coastal chlorophyll; it is not evidence about data-center effects. |
| [KNMI Climate Explorer](https://climexp.knmi.nl/) | Explore climate series and compare analysis workflows. | Reference tool; do not assume an integration API is available. |
| [Statistical test methods article](https://medium.com/@snp.kriss/statistical-test-methods-to-detect-trends-in-time-series-data-b361a0ec530b) | Introductory orientation for contributors. | Third-party explanation, not the scientific validation reference for implementation. |
| [Statistical significance guide](https://www.statsig.com/perspectives/a-comprehensive-guide-to-statistical-significance) | Introductory explanation of significance testing. | Third-party guide; verify numerical methods against primary references and meaningful test cases. |
| [RADARSAT Constellation Mission data](https://donnees-data.asc-csa.gc.ca/en/dataset/rcm) | Optional land, wetland, surface-water, and ecosystem investigation. | Radar imagery is not a direct air-quality or acoustic measurement. |
| [GEO.ca](https://geo.ca/) | Find Canadian geospatial and environmental context. | Evaluate the provenance, license, dates, and coverage of each selected dataset. |
| [SWOT mission information](https://www.asc-csa.gc.ca/eng/satellites/swot/) | Investigate changes in surface-water elevation. | Water elevation does not directly measure water quality, usable supply, or groundwater recharge. |
| [Monitoring ecosystems from space](https://www.asc-csa.gc.ca/eng/satellites/everyday-lives/monitoring-and-protecting-our-ecosystems-from-space.asp) | Background on satellite-based environmental indicators. | Indicator changes require interpretation and source-attribution work. |
| [CSA SAR Python tutorial](https://github.com/asc-csa/Synthetic_Aperture_Radar_Tutorial) | Learn SAR access and visualization workflows. | Optional extension, not a prerequisite for the starter's accounting demonstration. |

## Reusable code entry points

The following repositories were identified in the earlier repository review. They are **references for future work**, not installed dependencies or tested notebook workflows in this starter.

| Repository | Relevant implementation work |
| --- | --- |
| [nasa/gesdisc-tutorials](https://github.com/nasa/gesdisc-tutorials) | Regional time series, MERRA-2, rainfall, Giovanni services, and examples of calculating change. |
| [nasa/AppEEARS-Data-Resources](https://github.com/nasa/AppEEARS-Data-Resources) | Programmatic point/area requests and extracted outputs. |
| [nasa/LPDAAC-Data-Resources](https://github.com/nasa/LPDAAC-Data-Resources) | Data discovery, access guides, and links to mission-specific resources. |
| [nasa/MODIS-VIIRS-Data-Resources](https://github.com/nasa/MODIS-VIIRS-Data-Resources) | Vegetation and aerosol tutorials. |
| [nasa/harmony-py](https://github.com/nasa/harmony-py) | Supported spatial, temporal, and variable subsetting. |
| [nasa/Giovanni](https://github.com/nasa/Giovanni) | Analysis-workflow reference; deploying the entire platform is not a starter requirement. |
| [nasa/earthdata-mcp](https://github.com/nasa/earthdata-mcp) | Optional agent-assisted metadata discovery. Discovery must remain separate from numerical evidence and calculations. |
| [nasa/NASAaccess](https://github.com/nasa/NASAaccess) | Optional R-based access and reformatting of climate and hydrological data. |

Useful starting notebooks include [Giovanni area-average time series](https://github.com/nasa/gesdisc-tutorials/blob/main/notebooks/How_To_Access_the_Giovanni_Averaging_Service_Using_Python.ipynb) and [greenhouse-gas growth rates](https://github.com/nasa/gesdisc-tutorials/blob/main/notebooks/How_To_Calculate_Greenhouse_Gas_Growth_Rates.ipynb). Neither should be treated as a validated data-center impact model.

## Supplementary sources for the expanded scope

These are methodology/data references consulted during project research. Implementations must use suitable local alternatives when a source's geography does not match the selected region.

| Domain | Source | Intended role |
| --- | --- | --- |
| Long-range climate | [NEX-GDDP-CMIP6](https://www.nccs.nasa.gov/data-collections/nex-gddp-cmip6/), [dataset paper](https://ntrs.nasa.gov/citations/20240011616) | Historical and future climate scenarios through 2100; approximately 25 km grid spacing. Not building-scale evidence or a direct economic forecast. |
| Short-range atmosphere research | [STRATA model card](https://huggingface.co/nvidia/strata), [code](https://github.com/NVlabs/STRATA), [paper](https://arxiv.org/abs/2606.31248) | Optional research adapter. The paper demonstrates stable 24-hour rollouts with growing large-scale biases; it does not validate century-scale community projections. |
| Regional air quality | [GEOS-CF](https://gmao.gsfc.nasa.gov/gmao-products/geos-cf/), [GEOS-CF FAQ](https://gmao.gsfc.nasa.gov/gmao-products/geos-cf/faq_geos-cf/), [TEMPO](https://science.nasa.gov/mission/tempo/) | Short-range composition forecasts and observed regional pollution context. Confirm satellite-column versus surface-concentration definitions. |
| Data-center emissions | [EPA data-center resources](https://www.epa.gov/stationary-sources-air-pollution/clean-air-act-resources-data-centers) | Source categories, permit records, and references for local emissions modeling. |
| Electricity emissions | [EPA eGRID](https://www.epa.gov/egrid) | Historical US generation mix and emission factors. Regional average factors do not automatically represent marginal grid changes. |
| Bills and grid scenarios | [DOE large-load rate design brief](https://www.energy.gov/policy/articles/electricity-rate-designs-large-loads-evolving-practices-and-opportunities), [EIA Annual Energy Outlook](https://www.eia.gov/outlooks/aeo/) | Tariffs, cost allocation, and energy-market scenarios. Household bills require an explicit local rate model. |
| Cooling and water demand | [DOE cooling-water guidance](https://www.energy.gov/cmei/femp/cooling-water-efficiency-opportunities-federal-data-centers), [USGS data-center assessment](https://pubs.usgs.gov/publication/sir20265035/full) | Cooling-water efficiency, local availability, competing demand, and reporting uncertainty. |
| Water quality | [EPA water-quality overview](https://www.epa.gov/waterdata/water-quality-data), [Water Quality Portal](https://www.waterqualitydata.us/) | Ground-monitoring chemistry, temperature, and upstream/downstream observations. |
| Land conditions | [Landsat science products](https://www.usgs.gov/landsat-missions/landsat-science-products) | Surface temperature, vegetation, and land-change indicators. Surface temperature is not ambient air temperature. |
| Employment and unemployment | [BLS definitions](https://www.bls.gov/cps/definitions.htm) and relevant local labor-statistics agencies | Define employment, labor force, participation, and unemployment-rate denominators. |
| Population | [Census projection methodology](https://www.census.gov/programs-surveys/popproj/about.html) and relevant local demographic agencies | Cohort-based scenarios using fertility, mortality, and migration assumptions. |
| Noise pollution | [Environment Agency noise-modeling guidance](https://www.gov.uk/guidance/noise-impact-assessments-involving-calculations-or-modelling), [industrial-noise assessment guidance](https://www.gov.uk/government/publications/noise-and-vibration-management-environmental-permits/noise-and-vibration-management-environmental-permits) | Source sound data, background measurements, receptors, assumptions, and calibration. These UK references do not establish global noise limits. |

### Water Quality Portal freshness warning

As checked on **2026-11-14**, the [main Water Quality Portal](https://www.waterqualitydata.us/) warns that its legacy WQX2.2 profiles do not contain USGS records added after **2024-03-11**. It links to [WQX3.0 beta profiles](https://waterqualitydata.us/beta/) for recent records. Check the current service documentation and record freshness before implementing an adapter; a successful legacy query is not proof that the most recent measurements were retrieved.

## Before promoting a resource into a live adapter

Record the collection/product identifier and version, coverage, geographic resolution, temporal cadence, units, quality flags, scale/offset, missing-value encoding, access method, authentication, source citation, and license. Run a small authenticated or public retrieval where authorized, compare it with the source portal, and document the result. Do not make claims of live integration based only on a README or catalog listing.
