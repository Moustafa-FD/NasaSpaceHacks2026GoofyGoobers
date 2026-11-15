# Electricity costs: research, stored evidence and projection

This addition answers the user's electricity-only question: what did an average residential customer pay before the selected data center's timeline onset, what was the average in the selected year, and what would a continuation of the recent price trend imply? It uses electricity records, independently of the NASA environmental layers. NASA satellite measurements do not supply household electricity prices.

## Official evidence stored in the repository

Acquired 15 November 2026 from [EIA historical state electricity data](https://www.eia.gov/electricity/data/state/): the **Total Electric Industry**, **Residential** columns of the 1990–2009 and 2010-onward workbooks. The latter contains final annual 2025 data, released 7 October 2026. The extraction has **1,836 state-year records, 1990–2025, for the 50 states and District of Columbia**.

Files:

- `data/cloudshadow/electricity/index.json`: compact observed price, sales, revenue and customer counts; derived monthly bills and consumption; place coordinates; source metadata; projection assumptions.
- `data/cloudshadow/electricity/sources.json`: acquisition manifest with original download URLs, retrieval timestamps, byte counts and SHA-256 checksums.
- `scripts/fetch_electricity.py`: reproducible standard-library-only acquisition/extraction. Run `python scripts/fetch_electricity.py --download` to refresh. Raw workbooks remain in ignored `tmp/electricity-sources/`.

The two primary downloads are [1990–2009](https://www.eia.gov/electricity/data/state/xls/861/HS861%201990-2009.xlsx) and [2010 onward](https://www.eia.gov/electricity/data/state/xls/861/HS861%202010-.xlsx). Prices are **nominal US cents/kWh**. They are realized residential revenue per unit sold, including delivery-related charges, rather than a particular utility's advertised tariff. See [EIA's price-data explanation](https://www.eia.gov/tools/faqs/faq.php?id=507).

The monthly average is computed directly from each annual source row:

```
Average monthly bill (USD/customer) = residential revenue (thousand USD) × 1000 / customers / 12
Average monthly use (kWh/customer) = residential sales (MWh) × 1000 / customers / 12
```

Customers are residential accounts, not a surveyed count of occupied houses. The interface uses household language for readability while identifying the state-average proxy. An individual bill depends on tariff, use and other factors. Seven 1997–1998 source rows have published price values differing by more than 0.006¢/kWh from their revenue/sales ratio; these published values are retained with `qualityFlags`, not silently replaced. These rows precede all study-site baselines.

## Cities and map meaning

Thirty-three nearby towns/cities/CDPs across the five study areas use representative coordinates and exact state/GEOID assignments from the [2020 US Census Gazetteer](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2020.html). It supplies place locations, not utility territories or electricity prices. No population estimate is inferred from it.

The display selects **one nearest mapped city centroid** from the study site's approved nearby places, using geodesic distance within 80 km. Both the compact city card and optional expanded details use the same shared selection; first-listed or larger cities receive no priority. For example, Impact's mapped centroid is closer to the Abilene study site than Abilene's centroid. A nearest centroid is not a claim that the data center is inside that city's jurisdiction or supplied by its utility.

The single city card and heat marker use its **state residential average as a proxy**. Cities in the same state have the same price and color for the same comparison; no distance-decay electricity cost or invented city-level variation is generated. The marker identifies a location and is not a service-area boundary. Opening electricity details does not automatically zoom out or move the camera. If the mapped centroid is outside the current view, the compact cost details remain available without requiring a wide overview.

The baseline is the final full calendar year before the selected site's existing onset metadata: Colossus 1 **2023**, Colossus 2 **2024**, Ashburn **2011**, Abilene **2023**, The Dalles **2005**. Onset can mean construction or regional build-out, as defined in `sites.json`; it is not uniformly a commissioning date. Rewinding changes the scene and the selected cost year. A missing pre-onset year stays missing rather than using a post-onset substitute.

## Future estimate, 2026–2035

The browser's `electricity-data.js` fits an ordinary least-squares line to the latest ten observed annual **log prices** (currently 2016–2025), then applies that slope to the latest observed price:

```
price(year) = price(2025) × exp(fitted annual log-price slope × (year − 2025))
```

Anchoring at the actual final observation prevents a jump when the timeline enters projected years. A falling fitted trend is allowed to fall; observed decreases are preserved. Future household consumption is **held at the latest observed state's kWh/month**, so a projected bill is a price-only estimate, not a prediction of household demand. The separate constant-use comparison holds that same consumption in both the baseline and selected year; actual historical average bills still use that year's observed consumption.

The shaded **95% conditional model range** combines accumulated annual log-price innovation variance with fitted-slope uncertainty: `1.96 × sqrt(h × innovationVariance + h² × slopeVariance)` in log space. It is conditional on the trend/innovation assumptions, **not a calibrated ten-year prediction interval**. Policy, fuel shocks, utility rate cases, infrastructure, inflation, changing demand and cost allocation can break the trend. The app stops after ten projected years (**2035** with current records); it does not extend a trend to 2100.

Five rolling **one-year-ahead** hindcasts train only on earlier records, reporting mean absolute percentage error and the same metric for a carry-forward comparator. These measure short-horizon retrospective performance, not ten-year forecast skill. Current 2021–2025 hindcast errors are approximately TN 3.33%, MS 3.31%, VA 4.08%, TX 3.87%, OR 4.89%; these values are computed from the retained series, not claims of future accuracy.

## Attribution and missing evidence

**Before/after is not caused-by.** The map displays the all-cause state price change since a site's baseline. It cannot estimate how much of a household bill was caused by that data center. Electricity prices reflect fuel costs, construction and maintenance, regulation, weather and other demand. [EIA explains these drivers](https://www.eia.gov/energyexplained/electricity/prices-and-factors-affecting-prices.php). [Berkeley Lab's 2026 retail-price analysis](https://eta-publications.lbl.gov/publications/retail-electricity-price-trends-0) also finds geographically varying drivers; demand growth is not a universal one-direction price effect.

A causal facility-cost model would require utility service territories and actual residential tariffs, authorized rate cases, facility commissioning and metered load, contracted cost allocation, generation/transmission investment, fuel and wholesale market assumptions, and a defensible counterfactual without the project. Those are not contained in these state averages. [Virginia JLARC's data-center study](https://jlarc.virginia.gov/landing-2024-data-centers-in-virginia.asp) is useful regional context, but its scenario findings must not be transferred to every city or assigned to one facility.

Validation: `node --test tests/electricity-data.test.js` checks source units, extracted totals, genuine baseline dates, shared-state consistency, missing evidence, historical decreases, fractional timeline interpolation, bounded projections, uncertainty growth, no future-data leakage in hindcasts, and shared data loading.
