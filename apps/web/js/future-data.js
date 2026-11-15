// One shared model-output state for the dashboard and Cesium scene. Values keep
// their model periods; selecting a year never manufactures an annual forecast.
import {powerProjectionYear} from './power-projection.js';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value) => finite(value) ? value : null;
const median = (values) => { const a = values.filter(finite).sort((x, y) => x - y), i = Math.floor(a.length / 2); return a.length ? a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2 : null; };
const spread = (values) => { const a = values.filter(finite); return { median: median(a), min: a.length ? Math.min(...a) : null, max: a.length ? Math.max(...a) : null, models: a.length }; };
const period = (start, end) => ({ start, end, label: `${start}–${end}` });
export const FUTURE_CLIMATE_METRICS = Object.freeze({ meanTempC: { label: 'Regional temperature', unit: '°C' }, hotDays35C: { label: 'Very hot days ≥35°C', unit: 'days/year' }, precipMmPerYear: { label: 'Annual rainfall', unit: 'mm/year' } });

/** The live Python worker calls arbitrary-point products "point" even when
 * requested from a named study site. Bind them by requested coordinates while
 * keeping that original source identity; a generic ID is never a wildcard. */
export function futureProductMatchesSite(result, site) {
  if (!result || !site?.id) return false;
  const coordinatesMatch = (point) => {
    const lat = point?.lat ?? point?.latitude, lon = point?.lon ?? point?.longitude;
    return finite(lat) && finite(lon) && finite(site.lat) && finite(site.lon) && Math.abs(lat - site.lat) <= 1e-6 && Math.abs(lon - site.lon) <= 1e-6;
  };
  const sourceSite = result.site;
  if (typeof sourceSite === 'string') return sourceSite === site.id;
  if (sourceSite && typeof sourceSite === 'object') {
    if (sourceSite.id === 'point') return coordinatesMatch(sourceSite);
    if (sourceSite.id && sourceSite.id !== site.id) return false;
    const hasCoordinates = ['lat', 'lon', 'latitude', 'longitude'].some((key) => Object.hasOwn(sourceSite, key));
    if (hasCoordinates && !coordinatesMatch(sourceSite)) return false;
    if (!sourceSite.id && !hasCoordinates) return false;
  }
  // Daily climate results preserve requestedPoint separately from the nearest
  // source grid point; only the requested point is expected to match exactly.
  if (result.requestedPoint && !coordinatesMatch(result.requestedPoint)) return false;
  return true;
}

export function summarizeFutureClimate(result, { year = 2050, scenario = 'ssp245', metric = 'meanTempC' } = {}) {
  const requestedYear = Number(year), pathway = ['ssp245', 'ssp585'].includes(scenario) ? scenario : null;
  const windows = [period(2041, 2060), period(2081, 2100)];
  const distance = (p) => Math.max(p.start - requestedYear, 0, requestedYear - p.end);
  const selected = windows.reduce((a, b) => distance(a) <= distance(b) ? a : b);
  const row = pathway && result?.metrics?.[metric]?.[`${pathway}_${selected.start}_${selected.end}`], values = row?.value;
  const baseline = result?.metrics?.[metric]?.historical_1995_2014;
  const available = finite(requestedYear) && requestedYear > 2014 && requestedYear <= 2100 && finite(values?.median);
  return { available, requestedYear, scenario: pathway, metric, label: FUTURE_CLIMATE_METRICS[metric]?.label || metric,
    period: selected, periodContainsYear: requestedYear >= selected.start && requestedYear <= selected.end,
    value: available ? values.median : null, min: available ? number(values.min) : null, max: available ? number(values.max) : null,
    unit: FUTURE_CLIMATE_METRICS[metric]?.unit || result?.metrics?.[metric]?.unit || '', sourceUnit: result?.metrics?.[metric]?.unit,
    change: { median: available ? number(row?.changeFromHistorical?.median) : null, min: available ? number(row?.changeFromHistorical?.min) : null, max: available ? number(row?.changeFromHistorical?.max) : null },
    baseline: { period: period(1995, 2014), value: number(baseline?.median), min: number(baseline?.min), max: number(baseline?.max) },
    models: values?.models ?? result?.ensemble?.length ?? null, source: result?.source || null, evidence: result?.evidence || 'climate-scenario', gridPoints: result?.gridPoints || [],
    note: result?.evidenceNote || 'Regional climate-period scenario; model spread is not a confidence interval.', sampling: result?.sampling || null };
}

const agricultureUnits = { meanTemperatureC: '°C', heatThresholdDays: 'days/season', dryThresholdDays: 'days/season', frostDays: 'days/season', growingDegreeDaysCdays: '°C·days/season', precipitationMm: 'mm/season', referenceEvapotranspirationMm: 'mm/season', precipitationMinusReferenceEt0Mm: 'mm/season', meanSurfaceSoilMoisture: 'm³/m³' };
/** Aggregate only complete model years. A partial daily record cannot become a
 * plausible annual total or hot-day count, and omitted models stay explicit. */
export function summarizeDailyClimateYear(result, { year, metric = 'meanTempC' } = {}) {
  const selectedYear = Number(year), definitions = { meanTempC: ['temperature_2m_mean', '°C'], hotDays35C: ['temperature_2m_max', '°C'], precipMmPerYear: ['precipitation_sum', 'mm'] }, definition = definitions[metric];
  const expected = [];
  if (Number.isInteger(selectedYear) && selectedYear >= 1950 && selectedYear <= 2049) {
    for (let date = Date.UTC(selectedYear, 0, 1), end = Date.UTC(selectedYear + 1, 0, 1); date < end; date += 86400000) expected.push(new Date(date).toISOString().slice(0, 10));
  }
  const perModel = (result?.models || []).map((model) => {
    const input = model.metrics?.find((m) => m.id === definition?.[0]), rows = (input?.series || []).filter((p) => String(p.date).slice(0, 4) === String(selectedYear)), byDay = new Map(rows.map((p) => [p.date, p.value]));
    const complete = !!definition && expected.length > 0 && input?.units === definition[1] && rows.length === expected.length && byDay.size === expected.length && expected.every((date) => finite(byDay.get(date)));
    const values = complete ? expected.map((date) => byDay.get(date)) : [];
    const sum = values.reduce((a, b) => a + b, 0), value = !complete ? null : metric === 'meanTempC' ? sum / values.length : metric === 'hotDays35C' ? values.filter((v) => v >= 35).length : sum;
    return { model: model.model, available: complete, value, validDays: rows.filter((p) => finite(p.value)).length, expectedDays: expected.length };
  });
  const ensemble = spread(perModel.map((m) => m.value));
  return { available: finite(ensemble.median), year: selectedYear, metric, value: ensemble.median, min: ensemble.min, max: ensemble.max, unit: FUTURE_CLIMATE_METRICS[metric]?.unit || '', models: ensemble.models, requestedModels: perModel.length, perModel,
    period: { start: selectedYear, end: selectedYear, label: String(selectedYear) }, source: { name: 'HighResMIP / Open-Meteo', access: result?.sourceUrl }, evidence: result?.evidence || 'climate-scenario', scenario: result?.scenario, note: 'Complete model-year simulation; not a weather forecast or facility effect. Range is model sensitivity, not a confidence interval.' };
}
export function summarizeFutureProduct(kind, result, options = {}) {
  if(kind==='power-projection')return {...powerProjectionYear(result,{year:options.year,scenario:options.powerScenario||'ssp245'}),result};
  if(kind==='environment-screening'){
    const row=result?.years?.find(row=>row.year===options.year);
    return {available:!!row?.metrics?.some(m=>finite(m.value)),year:options.year,metrics:row?.metrics||[],requiredInputs:(result?.requiredInputs||[]).filter(r=>r.year===options.year),result};
  }
  if (kind === 'climate-projection') {
    const summary = summarizeFutureClimate(result, options);
    return { ...summary, metrics: Object.fromEntries(Object.keys(FUTURE_CLIMATE_METRICS).map((metric) => [metric, summarizeFutureClimate(result, { ...options, metric })])) };
  }
  if (kind === 'plume-scenario') return { available: Array.isArray(result?.grid?.values), result, evidence: result?.evidence || 'scenario', peak: result?.peak || null, unit: result?.emission ? 'µg/m³' : result?.grid?.units || 's/m³', period: result?.frames ? { start: result.frames.first, end: result.frames.last, label: `${result.frames.first} → ${result.frames.last}` } : null, note: result?.evidenceNote || '', annualForecast: false };
  if (kind === 'agriculture') {
    const metrics = Object.fromEntries(Object.entries(agricultureUnits).map(([key, unit]) => {
      const rows = (result?.comparisons || []).map((model) => model.indicators?.[key]).filter(Boolean), future = spread(rows.map((r) => r.futureMeanPerSeason)), before = spread(rows.map((r) => r.baselineMeanPerSeason));
      return [key, { available: finite(future.median), value: future.median, min: future.min, max: future.max, models: future.models, unit, change: spread(rows.map((r) => r.change)), baseline: { value: before.median, min: before.min, max: before.max } }];
    }));
    const p = result?.futurePeriod;
    return { available: Object.values(metrics).some((m) => m.available), result, metrics, period: p ? { ...p, label: `${p.start} → ${p.end}` } : null, settings: result?.settings || {}, evidence: result?.evidence || 'conditional-climate-screening', sources: result?.sources || [], note: 'Growing-season climate exposure; not crop yield or facility-attributable damage.' };
  }
  if (kind === 'climate') {
    const summary = summarizeDailyClimateYear(result, options);
    return { ...summary, result, metrics: Object.fromEntries(Object.keys(FUTURE_CLIMATE_METRICS).map((metric) => [metric, summarizeDailyClimateYear(result, { ...options, metric })])), requestPeriod: result?.period ? { ...result.period, label: `${result.period.start} → ${result.period.end}` } : null };
  }
  return null;
}

export function summarizeFutureTrend(result, { year, variable = 'LST_Day' } = {}) {
  const row = result?.rows?.find((r) => Number(r.Year) === Number(year)), supported = Number(year) <= 2035 && row?.Phase === 'projected';
  const variables = {};
  for (const id of ['LST_Day', 'LST_Night', 'NDVI', 'NO2_OMI', 'NO2', 'AOD', 'AirTemp']) {
    const value = row?.[`${id}_Site`], local = row?.[`${id}_Local`];
    const unit = id.startsWith('LST') || id === 'AirTemp' ? '°C' : id.startsWith('NO2') ? '×10¹⁵ molecules/cm²' : id;
    variables[id] = { available: supported && finite(value), variable: id, unit, year: Number(year), value: supported ? number(value) : null, min: supported ? number(row?.[`${id}_SiteLo`]) : null, max: supported ? number(row?.[`${id}_SiteHi`]) : null, local: supported ? number(local) : null, localMin: supported ? number(row?.[`${id}_LocalLo`]) : null, localMax: supported ? number(row?.[`${id}_LocalHi`]) : null, slopePerDecade: number(result?.projections?.[id]?.slopePerDecade), evidence: 'trend-extension', label: 'If the historical trend continues' };
  }
  return { ...(variables[variable] || { available: false }), variables, year: Number(year), lastObservedYear: result?.lastObservedYear, note: result?.note || 'Trend continuation through 2035; not a validated forecast.', result };
}

/** A dispersion footprint is shown only for years inside its own wind record:
 * a per-year product for exactly that year, a multi-year product within its first..last frames. */
export function plumeCoversYear(raw, year) {
  if (Number.isInteger(raw?.year)) return raw.year === year;
  const first = Number(String(raw?.frames?.first || '').slice(0, 4)), last = Number(String(raw?.frames?.last || '').slice(0, 4));
  return Number.isInteger(first) && Number.isInteger(last) && first > 0 && year >= first && year <= last;
}

export function attachFutureData({ site, year = 2025, eventTarget = globalThis.window, onRequest, fetchImpl = globalThis.fetch, dataBase = 'data', group = 'heat',loadSupplemental=false } = {}) {
  if (!eventTarget) throw new Error('A future-data event target is required.');
  const cache = new Map(), locations = new Map(), listeners = [], supported = new Set(['climate-projection', 'plume-scenario', 'agriculture', 'climate','environment-screening']),supplemental=new Set(['power-projection','regional-evidence','site-audit']);
  let destroyed = false, generation = 0, trendController, requestToken = 0;
  let current = { site, siteId: site?.id, year, scenario: 'ssp245',powerScenario:'ssp245',climateView:'annual', metric: 'meanTempC', group, climate: null, plume: null, agriculture: null, dailyClimate: null, trend: null, products: {}, status: '', error: '', pending: false };
  const fire = () => eventTarget.dispatchEvent(new CustomEvent('cs:future-state', { detail: { state: current } }));
  const rebuild = () => {
    const options = { year: current.year, scenario: current.scenario,powerScenario:current.powerScenario, metric: current.metric }, products = { ...(cache.get(current.siteId) || {}) };
    // A dispersion footprint belongs to one year of analysed winds; never show it for another year.
    if (products['plume-scenario'] && !plumeCoversYear(products['plume-scenario'], current.year)) delete products['plume-scenario'];
    current = { ...current, products: { ...products }, climate: products['climate-projection'] ? summarizeFutureProduct('climate-projection', products['climate-projection'], options) : null, plume: products['plume-scenario'] ? summarizeFutureProduct('plume-scenario', products['plume-scenario'], options) : null, agriculture: products.agriculture ? summarizeFutureProduct('agriculture', products.agriculture, options) : null, dailyClimate: products.climate ? summarizeFutureProduct('climate', products.climate, options) : null, trend: products.trend ? summarizeFutureTrend(products.trend, options) : null };
    current={...current,power:products['power-projection']?summarizeFutureProduct('power-projection',products['power-projection'],options):null,screening:products['environment-screening']?summarizeFutureProduct('environment-screening',products['environment-screening'],options):null,regional:products['regional-evidence']||null,audit:products['site-audit']||null};
    if (!destroyed) fire();
  };
  function ingest({ siteId, kind, result } = {}) {
    if (destroyed || !siteId || !result || (!supported.has(kind) && !supplemental.has(kind)&&kind !== 'trend')) return false;
    if (!futureProductMatchesSite(result, locations.get(siteId))) return false;
    const values = cache.get(siteId) || {}; if (values[kind] === result) return true;
    // A one-year "same inputs" screening recalculation adds that year to the earlier result.
    const previous = values[kind];
    if (kind === 'environment-screening' && previous?.years?.length && result.years?.length === 1) {
      const year = result.years[0].year;
      result = { ...result, years: [...previous.years.filter((r) => r.year !== year), ...result.years].sort((x, y) => x.year - y.year), requiredInputs: [...(previous.requiredInputs || []).filter((r) => r.year !== year), ...(result.requiredInputs || [])] };
    }
    values[kind] = result; cache.delete(siteId); cache.set(siteId, values);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    if (siteId === current.siteId) { current = { ...current, error: '' }; rebuild(); }
    return true;
  }
  async function setSite(next) {
    if (!next?.id) return;
    locations.delete(next.id); locations.set(next.id, next); while (locations.size > 12) locations.delete(locations.keys().next().value);
    if (current.siteId === next.id && cache.get(next.id)?.trend&&(!loadSupplemental||[...supplemental].every(kind=>cache.get(next.id)?.[kind]))) { current = { ...current, site: next }; rebuild(); return; }
    const token = ++generation; requestToken++; trendController?.abort();
    current = { ...current, site: next, siteId: next.id, status: '', error: '', pending: false }; rebuild();
    if (!fetchImpl || !/^[a-zA-Z0-9_-]{1,80}$/.test(next.id)) return;
    const controller = new AbortController(); trendController = controller;
    const sources=[['trend','unreal/timeline',''],...(loadSupplemental?[['power-projection','power-projections','power-projection/1.0'],['regional-evidence','regional-evidence','regional-evidence/1.0'],['site-audit','site-audit','site-audit/1.0']]:[])];
    await Promise.allSettled(sources.map(async([kind,path,schema])=>{
      try{
        const response=await fetchImpl(`${dataBase}/${path}/${next.id}.json`,{signal:controller.signal});if(!response.ok)return;
        const result=await response.json();
        if(!destroyed&&generation===token&&(kind==='trend'?result.site===next.id&&Array.isArray(result.rows):result.schemaVersion===schema))ingest({siteId:next.id,kind,result});
      }catch{/* Optional source coverage stays missing. */}
    }));
  }
  function setYear(value) { if (finite(value)) { current = { ...current, year: value }; rebuild(); } }
  function setOptions(options = {}) {
    const next = {};
    if (['ssp245', 'ssp585'].includes(options.scenario)) next.scenario = options.scenario;
    if(['ssp126','ssp245','ssp370'].includes(options.powerScenario))next.powerScenario=options.powerScenario;
    if(['annual','period'].includes(options.climateView))next.climateView=options.climateView;
    if(typeof options.showScreening==='boolean')next.showScreening=options.showScreening;
    if(['heat','air','water','noise'].includes(options.screeningDomain))next.screeningDomain=options.screeningDomain;
    if (Object.hasOwn(FUTURE_CLIMATE_METRICS, options.metric)) next.metric = options.metric;
    if (['heat', 'water', 'air', 'vegetation'].includes(options.group)) next.group = options.group;
    if (Object.entries(next).every(([key, value]) => current[key] === value)&&options.showScreening!==true) return;
    current = { ...current, ...next }; rebuild();
  }
  async function request(kind, options = {}) {
    if (!supported.has(kind) || destroyed || current.pending) return;
    const token = ++requestToken, siteId = current.siteId;
    current = { ...current, pending: true, error: '', status: 'Requesting model output…' }; fire();
    try {
      if (!onRequest) throw new Error('The model service is not connected.');
      const response = await onRequest(kind, { ...options, year: options.year ?? current.year });
      if (destroyed || token !== requestToken || current.siteId !== siteId) return;
      if (!response?.result) throw new Error('The model request did not return completed output.');
      if (!ingest({ siteId, kind, result: response.result })) throw new Error('The model output does not match this requested location.');
      current = { ...current, status: 'Model output ready.' };
    } catch (error) { if (!destroyed && token === requestToken && current.siteId === siteId) current = { ...current, error: error.message, status: 'Model output unavailable.' }; }
    finally { if (!destroyed && token === requestToken && current.siteId === siteId) { current = { ...current, pending: false }; fire(); } }
  }
  const on = (type, fn) => { eventTarget.addEventListener(type, fn); listeners.push([type, fn]); };
  on('cs:environment-data', ({ detail }) => ingest(detail));
  on('cs:environment-status', ({ detail: d }) => { if (d?.siteId === current.siteId && supported.has(d.kind)) { current = { ...current, pending: !!d.pending, status: d.status || '', error: d.error || '' }; fire(); } });
  for (const type of ['cs:site', 'cs:location']) on(type, ({ detail }) => { if (detail?.site) void setSite(detail.site); });
  on('cs:year', ({ detail }) => { if (!detail?.siteId || detail.siteId === current.siteId) setYear(detail?.year); });
  on('cs:future-options', ({ detail }) => setOptions(detail));
  on('cs:future-view', ({ detail }) => { if (!detail?.siteId || detail.siteId === current.siteId) setOptions({...detail,...(detail?.group!==current.group||detail?.enabled===true?{showScreening:false}:{})}); });
  on('cs:future-request', ({ detail }) => { if (!detail?.siteId || detail.siteId === current.siteId) void request(detail?.kind, detail || {}); });
  if (site) void setSite(site); else fire();
  return { setSite, setYear, setOptions, ingest, request, publish: fire, get state() { return current; }, destroy() { destroyed = true; generation++; requestToken++; trendController?.abort(); for (const [type, fn] of listeners) eventTarget.removeEventListener(type, fn); cache.clear(); locations.clear(); } };
}
