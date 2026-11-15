# Cheat sheet: what to remember for the judges

## The pitch in 15 seconds
AI data centers are changing the places around them, and nobody measures it independently. **Footprint Atlas** uses 20+ years of NASA satellite data to measure heat, greenness, air pollution and haze around 5 AI data centers. It tests whether each change is statistically real and shows it on a 3D globe you can slide from 2003 to 2100.

## The 5 numbers to know
| Site | Finding | Confidence |
|---|---|---|
| **Ashburn, VA** (headline) | Data-center area's **night-time surface heat +0.25 °C/decade beyond its surroundings**; regional air +0.71 °C/decade | p = 0.001 (strong) |
| **Colossus 1, Memphis** | **Greenness −0.06/decade** more than its surroundings | p = 0.003 (strong) |
| Colossus 1 | **NO₂ +0.24×10¹⁵** after the turbines (mid-2024) | p = 0.051 (**borderline**: say so) |
| Colossus 1 | Wind from the SSW (192°) pushes the plume **north**; Boxtown (ESE) gets it on westerly days | NASA GEOS-FP / POWER |
| All sites | Haze (AOD): **no significant increase** | n.s. |

## Did we train a model? **No.** So how do predictions work?

There's no AI or machine learning. We use four transparent methods, one per time range:

| Time range | How the number is made | Say it like this |
|---|---|---|
| **2003–2026 (past)** | Real NASA measurements. We decode NASA's map colours back into values and compare the site with its surroundings. | "This is measured, not modelled." |
| **2027–2035 (near future)** | **Trend extension.** We fit a robust trend line (Sen's slope) to the measured years and test it (Mann-Kendall, p-value). For the maps we do this **for every pixel** and only move pixels whose own trend is significant. Then: value in 2030 = latest real value + slope × years ahead. The 95% range widens every year. | "If the trend of the last 20 years continues, here is where it goes. It's an extension, not a forecast." |
| **2036–2100 (far future)** | **NASA's climate model runs** (NEX-GDDP-CMIP6: 5 global climate models, 2 emissions pathways). These are physics simulations NASA already ran; we read them for each site. | "Beyond 2035 a trend line means nothing, so we switch to NASA's physics-based climate models." |
| **Smoke plume (Colossus 1)** | A **Gaussian plume** formula (the standard textbook air-dispersion model) driven by NASA GEOS-FP winds for each year. | "Where the smoke would go, using real NASA winds. It shows dilution, not a concentration." |

**Why no machine learning is a strength:** with ~23 data points per site there is nothing to train on reliably. Statistics give a confidence level for every number, and anyone can check them. Our code is validated against SciPy.

## Why does it stop at 2035?
A straight line fitted to ~23 years isn't meaningful much beyond ~9 years ahead (under 40% of the record). After 2035 we use climate models instead.

## The data (all NASA, all free)
- **GIBS map tiles:** MODIS (surface heat, greenness, haze), OMI and TROPOMI (NO₂), MERRA-2 (air temperature), HLS (30 m yearly images).
- **NASA POWER API:** site weather.
- **GEOS-FP (OPeNDAP):** real 3-hourly winds.
- **Giovanni (Harmony API, Earthdata login):** water, soil, groundwater.
- **NEX-GDDP-CMIP6 (THREDDS):** climate to 2100.

## The tech stack
Python (data and statistics) → static JSON in Git → Node.js server and job API → **CesiumJS 3D globe** in the browser (WebGL2 fluid smoke, wind particles). **Unreal Engine 5.8 + Cesium** for the cinematic video.

## Three honesty lines (judges love these)
1. "Borderline stays borderline": NO₂ p = 0.051 is not reported as a finding.
2. "Change near a facility is evidence, not proof": we always compare with the surroundings.
3. "A trend extension is not a forecast": projected maps are labelled PROJECTED.

## Tricky questions
- **"Is the heat from the data center or climate change?"** We subtract the surrounding ring. Ashburn's night heat is +0.25 °C/decade **beyond** its surroundings, and the regional warming is reported separately.
- **"Why NO₂ from OMI and not TROPOMI?"** TROPOMI is sharper but only starts in Sep 2023; OMI goes back to 2004, which a trend needs.
- **"Why is the plume purple only at Colossus 1?"** It is the only site with documented on-site gas turbines.
- **"Why don't day-heat maps change much after 2026?"** Daytime surface heat has no significant trend at most pixels (0–6%). Night heat does (53–97%), so the Heat button shows night heat.
- **"Why does a projected map change only in some places?"** Only pixels with a statistically significant trend move; the rest stay at their latest value. Night heat (most pixels) and greenness at the campus move clearly; soil water has no significant trend at any site, so it stays put.
- **"How do you show water?"** Worldwide rainfall per year from NASA MERRA-2 (2003–2025), coloured wetter or drier than each place's normal. 2027–2035 continue each cell's measured trend where it is significant; there is no water map after 2035.
- **"Where do I see the future in the new interface?"** The PROJECTED 2035 button next to Before/After: the measured trend continued, pixel by pixel.
- **"Are the future wind trails a forecast?"** No. They replay NASA GEOS-FP 2025 winds as a reference pattern; nobody forecasts winds decades ahead.
- **"Can I check another place?"** Yes: click anywhere on the globe for a live NASA trend analysis.

Diagrams: [simple, 4 steps](colossus1-how-it-works.png) · [full architecture](architecture.png) · full detail: [technical-details.md](../technical-details.md)
