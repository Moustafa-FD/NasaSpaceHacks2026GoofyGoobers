# Data access and model research

Date: **2026-11-14**. This research was done before full implementation. Everything marked *tested* was run from this repository with the team's Earthdata token (read from `.env`, never printed or committed). Anything else comes from documentation and was not tested.

## 1. Access test results

| Service | Result (tested) | Notes / action |
| --- | --- | --- |
| Earthdata Login token | Valid **user** token issued 2026-11-14, **expires 2027-01-13** | Regenerate before then; keep it only in `.env` (ignored by Git) |
| NASA Harmony (`harmony.earthdata.nasa.gov/jobs`) | Accepted the token | — |
| Giovanni API quota (`api.giovanni.earthdata.nasa.gov/quota`) | **401 "Invalid bearer token"** | See fix below |
| Giovanni area-average via Harmony (`average=area`, `format=text/csv`) | **401 "Failed validating bearer token"** | Same cause |
| Giovanni configured-variables list | Public, 867 variables | Used for section 2 |
| GES DISC OPeNDAP (GPM IMERG monthly) | **401** | Same cause likely |
| Hydrology Data Rods | **Discontinued**; it now redirects to a GES DISC shutdown notice | Removed from the catalog |
| NASA POWER API (monthly point) | **Works, no login** | Pilot data in section 3 |
| GEOS-FP OPeNDAP (`opendap.nccs.nasa.gov/dods/GEOS-5/fp/0.25_deg/`) | **Works, no login**; subset returned in under 1 s | Global winds and pressure (section 5) |

**Update (same day, after the account owner enabled the apps):** Giovanni still returns 401, and GES DISC still blocks data. Tracing the redirect shows the cause: GES DISC answers **403 "EULA Acceptance Failure"** for its data application. The account must open the `approve_app` link GES DISC returns (in `urs.earthdata.nasa.gov`, client of the GES DISC archive) and accept its end-user licence agreement. OPeNDAP metadata (`.dds`) loads, but data requests stay at 401 until then. Wind/pressure/temperature fields now come from GEOS-FP instead (no login; see [flow-fields.md](../flow-fields.md)), and WeatherNext 3 is assessed there too.

**Original note (account owner must do this):** in Earthdata Login, open *Applications → Authorized Apps* and approve **"NASA GESDISC DATA ARCHIVE"**. Then sign in once at [Giovanni](https://giovanni.gsfc.nasa.gov/) with Earthdata Login and retest. Giovanni's tutorial uses the same kind of token (`earthaccess.get_edl_token()`), so the token type itself should be accepted. The API also has a **monthly compute quota**.

## 2. Giovanni variables for the environmental scope

These were selected from the live configured-variables list. Use the IDs exactly as written.

| Theme | Giovanni variable ID | Cadence / grid | Notes |
| --- | --- | --- | --- |
| Air | `OMNO2d_003_ColumnAmountNO2TropCloudScreened` | daily, 0.25°, 2004– | Column, not breathing-level |
| Air | `OMSO2e_003_ColumnAmountSO2`, `OMAERUVd_003_*` | daily | SO₂ column, UV aerosol index |
| Air | `M2T1NXAER_5_12_4_TOTEXTTAU` | **hourly** MERRA-2 | Heavy on quota for long records |
| Heat | `M2SDNXSLV_5_12_4_T2MMEAN`, `..._T2MMAX` | daily, 0.5°×0.625°, 1980– | Monthly MERRA-2 collections are **not** in the configured list |
| Heat | `NLDAS_FORA0125_M_2_0_Tair` | monthly, **0.125°**, US | Finest grid on the list |
| Wind | `NLDAS_FORA0125_M_2_0_Wind_E`, `..._Wind_N` | monthly, 0.125°, US | East/north components; trend-test components, not direction |
| Wind | `M2T1NXSLV_5_12_4_U10M`, `V10M` | hourly | Global |
| Water | `GPM_3IMERGM_07_precipitation` | monthly, 0.1°, 2000– | |
| Water | `GLDAS_NOAH025_M_2_1_SoilMoi0_10cm_inst`, `..._Evap_tavg`, `..._RootMoist_inst` | monthly, 0.25° | |
| Water | `NLDAS_NOAH0125_M_2_0_SoilM_0_100cm`, `..._Streamflow` | monthly, 0.125°, US | |
| Water | `GRACEDADM_CLSM0125US_7D_4_0_gws_inst` | weekly, 0.125°, US | Groundwater storage (assimilated GRACE) |
| Land / agriculture | none | — | MODIS NDVI (MOD13Q1) and LST (MOD11A2) come from **AppEEARS** (separate API, not yet tested) |

## 3. Pilot run on real NASA data (NASA POWER, monthly 1991–2024)

Sites (tentative, team to confirm): **Ashburn, VA** (39.04, −77.49), inside the Northern Virginia data-center cluster, and a **control** in southern Fauquier County (38.55, −77.80), a mostly rural part of the same Piedmont. POWER's meteorology is MERRA-2/GEOS-based on a ~0.5°×0.625° grid, so each site is one coarse cell. Raw files are in `data/raw/power/` (ignored by Git; the retrieval date is in each file header).

| Variable | Ashburn (Sen slope/decade, 95% CI, MK p) | Control | Ashburn − control |
| --- | --- | --- | --- |
| Air temperature T2M (°C) | **+0.50** [0.35, 0.66], p = 8e-9 | **+0.54** [0.39, 0.70], p = 2e-10 | −0.02 [−0.04, 0], p = 0.03 |
| Daily max temperature (°C) | **+0.40** [0.13, 0.69], p = 0.004 | **+0.42**, p = 0.004 | not significant |
| Precipitation (mm/day) | not significant | not significant | not significant |
| Wind speed 10 m (m/s) | **−0.031**, p = 0.02 | not significant (p = 0.07) | −0.015, p = 0.006 |
| Relative humidity (%) | not significant | not significant | not significant |
| Topsoil wetness (0–1) | −0.01, p = 0.02 | −0.01, p = 0.009 | ties (see below) |
| Surface solar (kWh/m²/day) | +0.13, p = 0.02 | +0.15, p = 0.009 | not significant |

**Interpretation:** both sites warmed about 0.5 °C per decade, which is significant and regional. The difference between them is near zero, so at this resolution there is no detectable extra warming at the data-center cluster. That is the expected answer for a ~50 km grid, and it shows why the tool must never attribute a regional trend to a facility. Finer products (NLDAS 0.125°, MODIS LST 1 km, Landsat 30 m) are needed to look for local signals.

**Engine issues found by real data (to fix during implementation):**

1. *Ties from rounded values.* POWER publishes 2 decimals, so differences repeat. Sen's slope can then be exactly 0 while Mann-Kendall gives p < 0.05, and the summary wording becomes contradictory. Fix: report the data's resolution, and word the summary from both statistics.
2. *Wind direction is circular.* Degrees cannot be trend-tested linearly (359° and 1° are neighbours). `WD10M` was excluded. Use u/v components (NLDAS `Wind_E`/`Wind_N`, MERRA-2 `U10M`/`V10M`) or circular statistics.

## 3b. Giovanni results for all five sites (real NASA data)

After the GES DISC licence was accepted, `python -m services.models.trends.giovanni` downloaded 25 area-averaged series (5 sites × 5 variables; site box ±0.25°) in about 8 minutes. Giovanni quota use stayed at 0%. Trends below use **annual values with the Hamed-Rao correction and the autocorrelation-adjusted t-test**. Monthly seasonal Mann-Kendall assumes years are independent, and it overstated significance for storage variables (Ashburn groundwater: monthly p < 1e-16, annual p ≈ 0.05).

| Variable (Giovanni ID) | Ashburn | Colossus 1 / 2 (Memphis) | Abilene | The Dalles |
| --- | --- | --- | --- | --- |
| Tropospheric NO₂, OMI (`OMNO2d_003_…TropCloudScreened`), 2005–2025 | **−1.63×10¹⁵ molec/cm²/decade**, p < 0.001 (both tests) | **−5.5 / −6.1×10¹⁴**, p < 0.02 (both tests) | n.s. | n.s. |
| Groundwater storage, GRACE-DA (`GRACEDADM_CLSM0125US_7D_4_0_gws_inst`), 2003–2025 | −19.3 mm/decade, **borderline** (MK-HR p = 0.0497; t-test p = 0.27) | n.s. | n.s. (−17.2) | n.s. |
| Topsoil moisture 0–10 cm, GLDAS (`…SoilMoi0_10cm_inst`), 2001–2025 | n.s. | **−1.23 kg/m²/decade** (p = 0.047; t-test 0.07) / n.s. | **−1.36**, p = 0.038 (t-test 0.013) | n.s. |
| Precipitation, GPM IMERG monthly, 2001–2025 | n.s. | n.s. | n.s. | n.s. |
| Evapotranspiration, GLDAS | rising at 4 sites on monthly tests; annual not yet run | | | |

Reading these honestly:

- **NO₂ fell strongly at Ashburn and Memphis.** This matches the national decline from vehicle and power-plant controls. Any data-center contribution would have to show up as a **site-minus-surroundings** difference, which is how the web app's ring analysis works, not as the raw regional trend.
- Groundwater and soil-moisture products are **regional** (GRACE effective resolution ~300 km; GLDAS 0.25°). They describe the water setting a facility sits in; they don't measure its withdrawals.
- **Engine changes from this run:**
  - The Hamed-Rao correction may now only widen uncertainty. At Abilene, negative autocorrelation had shrunk the variance and given p = 9e-6.
  - p-values below double precision print as "< 1e-16".
  - For persistent storage variables (groundwater, soil moisture), use `--cadence annual`.

## 4. One-time CSV downloads versus a continuous loop

**Recommendation: versioned snapshots plus a bounded incremental refresh. Do not run a perpetual loop.**

- Monthly products add one value per month, with latency (for example, GPM IMERG final runs months behind). Re-running a trend on the same record changes nothing, and adding one month barely changes a 20-year trend.
- Judges and teammates need reproducible numbers, so each analysis should cite a frozen snapshot: source, collection version, variable, bbox, period, retrieval time and job ID.
- Giovanni has a **monthly compute quota**, and a loop would spend it for no gain.
- [AGENTS.md](../../AGENTS.md) requires every recurring task to have a reachable stop condition.

Design:

- `data/raw/<source>/<snapshot-date>/<variable>.csv` plus a `.provenance.json` (the probe already writes this shape).
- A `refresh` command that reads the last time step stored, asks the service only for newer steps, and **exits when there is nothing new**. Run it by hand, or schedule it monthly for trend data.
- The only fast-changing layers are live forecasts (GEOS-FP, GEOS-CF, HRRR), which update every few hours. For the demo, use a refresher that runs every 6 hours and has an explicit end date (the end of the event).

## 5. Replacing STRATA for winds, pressure and temperature

Visual detail in Unreal comes from **field resolution and rendering** (Niagara particles advected by u/v wind textures, isobar lines from pressure, colour ramps for temperature), not from an AI model. All the fields STRATA would have produced are already available from operational NASA and NOAA systems, without a GPU and without STRATA's 24-hour stability limit.

| Need | Source | Resolution / horizon | Access | Effort | Use in this project |
| --- | --- | --- | --- | --- | --- |
| Global winds, pressure, temperature now and in the near future | **NASA GEOS-FP** | 0.25°×0.3125°, 1–3-hourly; 5-day forecasts; rolling archive | OPeNDAP, no login (**tested**). Variables include `u10m v10m u50m v50m slp ps t2m ts qv2m` | Low | Main global wind/pressure layer |
| Air quality with meteorology | **NASA GEOS-CF** | ~25 km, 5-day forecasts | OPeNDAP | Low | NO₂, O₃, PM2.5 layers |
| Very detailed local winds (US) | **NOAA HRRR** | **3 km**, hourly, 18–48 h; archive since 2014 | AWS Open Data, Zarr, no account | Medium | Close-up wind over Northern Virginia |
| Historical replay of any date | **MERRA-2** (`M2T1NXSLV`, `M2I3NPASM` pressure levels) | 0.5°×0.625°, hourly, 1980– | GES DISC (after the account fix) | Low | Past winds/pressure; trend inputs |
| Global forecast backup | NOAA GFS | 0.25°, 16 days | AWS / NOMADS | Low | Fallback |
| Pollutant transport ("fluid" plume) | **NOAA HYSPLIT**, driven by HRRR or GFS | Trajectories / dispersion plumes | Free download (public Windows build); READY web API | Medium | Plume from a facility's generators using permit-based emission assumptions, labelled as a scenario |
| Building-scale airflow | CFD (OpenFOAM) / LES (PALM-4U) | Metres, minutes | Open source, needs HPC | High | Stretch goal; one site; illustrative only |
| AI weather models | NVIDIA Earth2Studio (FourCastNet3, StormCast 3 km US, AIFS, GraphCast and others) | 0.25° / 3 km, days | Linux and NVIDIA GPU | High | Not needed: GEOS-FP/HRRR already provide forecasts with the same short horizon |
| 2030–2100 climate | **NEX-GDDP-CMIP6** | 0.25°, daily, to 2100; CC0 | Public cloud | Medium | `tas, tasmax, tasmin, pr, hurs, huss, rsds, rlds, sfcWind` (**speed only: no wind direction, no pressure**) |
| Future wind direction / pressure | Raw CMIP6 (`ua, va, psl`) | ~100 km | ESGF / Pangeo cloud | Medium | Regional context only |

No source gives a credible 3 km wind field for 2050. Future wind visuals should reuse present-day patterns (GEOS-FP/HRRR climatology), labelled as such, and show CMIP6 changes only for temperature, rainfall and wind speed.

### Recommended stack

1. **Trend detective (challenge core):** Giovanni/GES DISC + NASA POWER + AppEEARS → `services/models/trends`.
2. **Live visual layers:** GEOS-FP winds/pressure/temperature, GEOS-CF air quality, HRRR close-up over the US pilot.
3. **Plume demo:** HYSPLIT with HRRR meteorology and documented emission assumptions.
4. **Future scenarios:** NEX-GDDP-CMIP6 changes for temperature, rainfall and wind speed.
5. **Unreal hand-off:** export u/v as velocity textures (GeoTIFF/PNG encoded in R/G channels) for Niagara advection, sea-level pressure as isobar polylines, and temperature as a colour overlay. Every layer keeps its source, resolution and valid time.

## 6. Open actions

- **Account owner:** authorize the GES DISC application and sign in to Giovanni once (section 1). Then retest the probe.
- **Team:** confirm the pilot site and control region, and the variables to snapshot first.
- **Implementation:** turn the research probes into tested adapters (Giovanni/Harmony, POWER, GEOS-FP subset), fix the two engine issues in section 3, and add AppEEARS.

## Sources

- [Giovanni averaging-service tutorial (gesdisc-tutorials)](https://github.com/nasa/gesdisc-tutorials/blob/main/notebooks/How_To_Access_the_Giovanni_Averaging_Service_Using_Python.ipynb)
- [NASA POWER](https://power.larc.nasa.gov/)
- [GEOS-FP at NCCS](https://www.nccs.nasa.gov/?p=5415) and [OPeNDAP 0.25° directory](https://opendap.nccs.nasa.gov/dods/GEOS-5/fp/0.25_deg)
- [NOAA HRRR on AWS](https://registry.opendata.aws/noaa-hrrr-pds) and [HRRR Zarr (Herbie guide)](https://herbie.readthedocs.io/en/latest/gallery/bonus_notebooks/zarr_HRRR.html)
- [HYSPLIT: Get & Run](https://arl.noaa.gov/?p=8892), [HYSPLIT met data on AWS](https://registry.opendata.aws/noaa-arl-hysplit/), [READY forecast met data](https://www.ready.noaa.gov/READYmetdata.php)
- [NEX-GDDP-CMIP6 Tech Note 4](https://www.nccs.nasa.gov/sites/default/files/NEX-GDDP-CMIP6-Tech_Note_4.pdf) and [dataset paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9163132)
- [Earth2Studio models](https://nvidia.github.io/earth2studio/modules/) and [Earth-2 open models overview](https://huggingface.co/blog/nvidia/earth-2-open-models)
