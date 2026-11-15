// Official EIA state averages. Nearby city markers use the corresponding state proxy.
// Forecasts are conditional historical-trend projections; no facility attribution.
export const ELECTRICITY_DATA_URL = 'data/electricity/index.json';
export const ELECTRICITY_KIND = 'Electricity';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const modelCache = new WeakMap();
const dataCache = new WeakMap();

export function loadElectricityData({ fetchImpl = fetch } = {}) {
  if (!dataCache.has(fetchImpl)) {
    const task = (async () => {
      const response = await fetchImpl(ELECTRICITY_DATA_URL);
      if (!response.ok) throw new Error('Electricity evidence is unavailable.');
      const data = await response.json();
      if (data?.schemaVersion !== 1 || !data.states || !Array.isArray(data.cities)) throw new Error('Unrecognized electricity evidence format.');
      return data;
    })();
    dataCache.set(fetchImpl, task);
    task.catch(() => { if (dataCache.get(fetchImpl) === task) dataCache.delete(fetchImpl); });
  }
  return dataCache.get(fetchImpl);
}

export function electricityDistanceKm(a, b) {
  const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function nearbyElectricityCities(data, site, limit = 8) {
  if (!site || !finite(site.lat) || !finite(site.lon)) return [];
  const ids = data?.sites?.[site.id]?.cityIds;
  return (data?.cities || []).filter(c => data.states?.[c.state] && (!ids || ids.includes(c.id)))
    .map(c => ({ ...c, distanceKm: electricityDistanceKm(site, c) }))
    .filter(c => c.distanceKm <= 80)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.max(0, Math.min(24, limit)));
}

/** Closest approved mapped city centroid within 80 km; not the site's jurisdiction or utility. */
export function nearestElectricityCity(data, site) {
  if (!Array.isArray(data?.sites?.[site?.id]?.cityIds)) return null;
  const city = nearbyElectricityCities(data, site, 1)[0];
  return city && data.states?.[city.state]?.records?.some(r => finite(r.priceCentsKwh) && r.priceCentsKwh > 0) ? city : null;
}

/** Ten-year log-price fit; no clipping of negative trends and no facility demand term. */
export function fitElectricityTrend(records, trainingYears = 10) {
  const rows = records.filter(r => finite(r.year) && finite(r.priceCentsKwh) && r.priceCentsKwh > 0).slice(-trainingYears);
  if (rows.length < 5 || rows.some((r, i) => i && r.year !== rows[i - 1].year + 1)) return null;
  const x = rows.map(r => r.year), y = rows.map(r => Math.log(r.priceCentsKwh));
  const mx = mean(x), my = mean(y), sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (!sxx) return null;
  const slope = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx;
  const residualVariance = y.reduce((s, v, i) => s + (v - my - slope * (x[i] - mx)) ** 2, 0) / (rows.length - 2);
  const innovations = y.slice(1).map((v, i) => v - y[i] - slope);
  const innovationVariance = innovations.reduce((s, v) => s + v ** 2, 0) / Math.max(1, innovations.length - 1);
  return { slope, slopeVariance: residualVariance / sxx, innovationVariance, trainingStartYear: x[0], trainingEndYear: x.at(-1), sampleCount: rows.length };
}

export function validateElectricityTrend(records, trainingYears = 10) {
  const errors = [], naiveErrors = [];
  for (let i = Math.max(trainingYears, records.length - 5); i < records.length; i++) {
    const history = records.slice(0, i), model = fitElectricityTrend(history, trainingYears), target = records[i], latest = history.at(-1);
    if (!model || target.year !== latest.year + 1) continue;
    const prediction = latest.priceCentsKwh * Math.exp(model.slope);
    errors.push(Math.abs(prediction / target.priceCentsKwh - 1) * 100);
    naiveErrors.push(Math.abs(latest.priceCentsKwh / target.priceCentsKwh - 1) * 100);
  }
  return { validationMaePct: errors.length ? mean(errors) : null, naiveMaePct: naiveErrors.length ? mean(naiveErrors) : null, validationCount: errors.length, validationHorizonYears: 1 };
}

function stateModels(data, state, records) {
  if (!modelCache.has(data)) modelCache.set(data, new Map());
  const cache = modelCache.get(data);
  if (!cache.has(state)) {
    const n = data.projection?.trainingYears || 10;
    cache.set(state, { ...fitElectricityTrend(records, n), ...validateElectricityTrend(records, n) });
  }
  return cache.get(state);
}

function annualPoint(records, model, year, last, through) {
  if (!finite(year) || year < records[0]?.year || year > through) return null;
  const exact = records.find(r => r.year === year);
  if (exact) return { ...exact, kind: 'observed', interpolated: false, billBasis: 'observed-average', lowerPriceCentsKwh: null, upperPriceCentsKwh: null };
  if (year <= last.year) {
    const a = records.find(r => r.year === Math.floor(year)), b = records.find(r => r.year === Math.ceil(year));
    if (!a || !b) return null; // Never bridge a missing observation.
    const t = year - a.year, mix = (key) => a[key] + (b[key] - a[key]) * t;
    return { year, priceCentsKwh: mix('priceCentsKwh'), monthlyBillUsd: mix('monthlyBillUsd'), monthlyKwh: mix('monthlyKwh'), kind: 'observed', interpolated: true, billBasis: 'interpolated-observed-average', lowerPriceCentsKwh: null, upperPriceCentsKwh: null };
  }
  if (!finite(model.slope)) return null;
  const h = year - last.year, logDelta = model.slope * h;
  const spread = 1.96 * Math.sqrt(h * model.innovationVariance + h * h * model.slopeVariance);
  const price = last.priceCentsKwh * Math.exp(logDelta);
  return { year, kind: 'projected', interpolated: !Number.isInteger(year), priceCentsKwh: price,
    monthlyBillUsd: price * last.monthlyKwh / 100, monthlyKwh: last.monthlyKwh, billBasis: `fixed-${last.year}-usage`,
    lowerPriceCentsKwh: last.priceCentsKwh * Math.exp(logDelta - spread), upperPriceCentsKwh: last.priceCentsKwh * Math.exp(logDelta + spread) };
}

/** Selected year and genuine pre-onset baseline. Unknowns stay null, never zero. */
export function electricitySnapshot(data, cityOrState, year, onsetYear) {
  const state = typeof cityOrState === 'string' ? cityOrState : cityOrState?.state;
  const entry = data?.states?.[state], records = entry?.records || [], last = records.at(-1);
  const onset = typeof onsetYear === 'string' ? Number(onsetYear.slice(0, 4)) : onsetYear;
  const baseline = finite(onset) ? records.filter(r => r.year < onset).at(-1) : null;
  const through = last ? last.year + (data.projection?.horizonYears || 10) : null;
  const common = { year, state, stateName: entry?.name ?? state ?? null,
    geographyLabel: entry ? `${entry.name} state average · city proxy` : 'No state electricity evidence',
    baselineYear: baseline?.year ?? null, baselinePriceCentsKwh: baseline?.priceCentsKwh ?? null, baselineBillUsd: baseline?.monthlyBillUsd ?? null, baselineMonthlyKwh: baseline?.monthlyKwh ?? null,
    lastObservedYear: last?.year ?? null, firstObservedYear: records[0]?.year ?? null, projectionThrough: through,
    comparisonMonthlyKwh: last?.monthlyKwh ?? null, comparisonUsageYear: last?.year ?? null,
    attribution: 'All-cause state price change; no data-center share is estimated.',
    facilityPhase: finite(onset) ? (year < onset ? 'before' : 'after') : 'unknown', onsetYear: finite(onset) ? onset : null,
    sourceIds: [...new Set(records.map(r => r.sourceId).filter(Boolean))],
  };
  const unavailable = (reason) => ({ ...common, kind: 'unavailable', reason, priceCentsKwh: null, monthlyBillUsd: null, monthlyKwh: null, changePct: null, billChangeUsd: null,
    lowerPriceCentsKwh: null, upperPriceCentsKwh: null, lowerBillUsd: null, upperBillUsd: null, baselineComparableBillUsd: null, monthlyComparableBillUsd: null, comparableBillChangeUsd: null });
  if (!last) return unavailable('No residential electricity record for this state.');
  if (!finite(year)) return unavailable('Select a year.');
  const model = stateModels(data, state, records), point = annualPoint(records, model, year, last, through);
  if (!point) return unavailable(year > through ? `The conditional trend stops at ${through}.` : year < records[0].year ? `Records begin in ${records[0].year}.` : 'Missing observation or insufficient projection evidence.');
  const baselineComparable = baseline ? baseline.priceCentsKwh * last.monthlyKwh / 100 : null;
  const monthlyComparable = point.priceCentsKwh * last.monthlyKwh / 100;
  return { ...common, ...point, ...model, trendAnnualPct: finite(model.slope) ? (Math.exp(model.slope) - 1) * 100 : null,
    changePct: baseline ? (point.priceCentsKwh / baseline.priceCentsKwh - 1) * 100 : null,
    billChangeUsd: baseline ? point.monthlyBillUsd - baseline.monthlyBillUsd : null,
    baselineComparableBillUsd: baselineComparable, monthlyComparableBillUsd: monthlyComparable,
    comparableBillChangeUsd: baseline ? monthlyComparable - baselineComparable : null,
    lowerBillUsd: point.lowerPriceCentsKwh == null ? null : point.lowerPriceCentsKwh * last.monthlyKwh / 100,
    upperBillUsd: point.upperPriceCentsKwh == null ? null : point.upperPriceCentsKwh * last.monthlyKwh / 100,
    projectionNote: point.kind === 'projected' ? 'Conditional trend, not a utility forecast. Future usage held constant; 95% model range is not long-horizon calibrated.' : null,
  };
}

export const formatMoney = (value, decimals = 0) => finite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) : 'Unavailable';
export const formatPrice = (value) => finite(value) ? `${value.toFixed(2)}¢/kWh` : 'Unavailable';
