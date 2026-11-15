// Environmental evidence transport. Static products need no API; live runs are explicit.
export const ENVIRONMENT_ACTIONS = [
  ['series', '30-year weather context (NASA POWER)', 'Monthly reanalysis, 1991–2020; a separate 30-year context, not the 20-year CMIP6 baseline.'],
  ['air-quality', 'Air quality history (CAMS)', 'Modeled near-surface concentrations; not measurements or facility emissions.'],
  ['land-water', 'Rain and soil moisture (ERA5)', 'Daily regional reanalysis; not river flow or facility water use.'],
  ['water-quality', 'Water station observations (USGS)', 'A source station ID is required. Missing/censored results remain unknown.'],
  ['trend-analysis', 'Analyze a completed time series', 'Statistical change, not attribution. Choose a loaded variable below.'],
  ['climate-projection', 'Climate scenarios to 2100', 'Five-model CMIP6 ensemble under SSP2-4.5 and SSP5-8.5; sample years bound download cost.'],
  ['plume-scenario', 'Relative plume screening', 'Assumed effective stack height; dilution only unless a sourced emission rate is supplied.'],
  ['climate', 'Daily climate scenarios (HighResMIP)', 'Two conditional model simulations through 2049; not a weather forecast.'],
  ['agriculture', 'Agricultural climate exposure', 'Explicit heat/dry-day thresholds; no crop yield, suitability or facility damage model.'],
  ['facilities-sync', 'Refresh nearby mapped facilities', 'Real OSM elements; incomplete coverage and possible campus duplicates.'],
  ['emissions-epa', 'Acquire US reported emissions inventory', 'NEI sector candidates; annual inventory estimates, not ambient concentrations.'],
  ['emissions-npri', 'Acquire Canadian reported releases', 'NPRI sector candidates; preserves missing amounts, methods and source units.'],
  ['ground-evidence', 'Import source-referenced observations', 'Paste records with source references. Imported records are not independently verified.'],
  ['grid', 'Read cached global weather frame', 'One NASA POWER native grid; requires acquired cache coverage.'],
  ['sync', 'Acquire bounded weather cache', 'Downloads a bounded POWER cache and curated catalog; may take several minutes.'],
];

const day = (date) => date.toISOString().slice(0, 10);
const validNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** A bounded source period, not an extrapolation beyond HighResMIP coverage. */
export function futureRequestPeriod(year, now = new Date()) {
  const first = now.getUTCFullYear() + 1, selected = Math.max(first, Math.trunc(year));
  if (!Number.isFinite(selected) || selected > 2049 || first > 2049) throw new Error('This agricultural/daily-climate model supports future periods only through 2049. Select 2049 or earlier; climate ensemble scenarios remain available through 2100.');
  const end = Math.min(2049, Math.max(first + 4, selected)), start = Math.max(first, end - 4);
  return { start: `${start}-01-01`, end: `${end}-12-31` };
}
export function sitePoint(site) {
  if (!validNumber(site?.lat) || !validNumber(site?.lon) || Math.abs(site.lat) > 90 || Math.abs(site.lon) > 180) throw new Error('Select a valid map location.');
  return { latitude: site.lat, longitude: site.lon };
}

export function buildEnvironmentRequest(action, site, year = 2025, options = {}) {
  const now = options.now || new Date(), point = sitePoint(site), schemaVersion = '1.0';
  const selected = Math.max(1981, Math.min(Math.trunc(year), now.getUTCFullYear() - 1));
  const endDate = new Date(Math.min(Date.UTC(selected, 6, 7), now.getTime() - 7 * 86400000));
  const end = day(endDate), start = day(new Date(endDate.getTime() - 6 * 86400000));
  const base = { schemaVersion, kind: action };
  switch (action) {
    case 'series': return { ...base, source: 'power-point', point, variables: ['T2M', 'PRECTOTCORR', 'RH2M', 'WS2M'], start: '1991-01', end: '2020-12' };
    case 'air-quality': {
      if (selected < 2022) throw new Error('CAMS history starts in August 2022. No air-quality history is available for this timeline year; choose 2022 or later.');
      return { ...base, point, start: selected === 2022 ? '2022-08-01' : start, end: selected === 2022 ? '2022-08-07' : end, variables: ['pm2_5', 'nitrogen_dioxide', 'ozone'] };
    }
    case 'land-water': return { ...base, point, start: `${selected}-01-01`, end: `${selected}-12-31` };
    case 'water-quality': return { ...base, stationId: options.stationId || '', start, end, parameters: ['00010', '00095', '00400', '00300', '63680'] };
    case 'trend-analysis': {
      if (!options.runId || !options.variable) return { ...base, input: { runId: '', variable: '' }, cadence: 'monthly', minYears: 10 };
      return { ...base, input: { ...(options.runIds ? { runIds: options.runIds } : { runId: options.runId }), variable: options.variable, ...(options.model ? { model: options.model } : {}) }, cadence: options.cadence || 'monthly', minYears: 10 };
    }
    case 'climate-projection': return { ...base, point, perWindow: 2 };
    case 'plume-scenario': return { ...base, ...(['ashburn', 'colossus1', 'colossus2', 'abilene', 'thedalles'].includes(site.id) ? { siteId: site.id } : { point }), effectiveHeightM: 20, landUse: 'urban' };
    case 'climate': return { ...base, point, ...futureRequestPeriod(year, now), models: ['EC_Earth3P_HR', 'MRI_AGCM3_2_S'] };
    case 'agriculture': return { ...base, point, baseline: { start: '2000-01-01', end: '2004-12-31' }, future: futureRequestPeriod(year, now), models: ['EC_Earth3P_HR', 'MRI_AGCM3_2_S'], growingMonths: [4, 5, 6, 7, 8, 9], baseTemperatureC: 10, heatThresholdC: 35, dryDayThresholdMm: 1 };
    case 'facilities-sync': {
      const dx = .06 / Math.max(.2, Math.cos(site.lat * Math.PI / 180));
      return { ...base, bbox: [Math.max(-180, site.lon - dx), Math.max(-90, site.lat - .06), Math.min(180, site.lon + dx), Math.min(90, site.lat + .06)] };
    }
    case 'emissions-epa': return { schemaVersion, kind: 'emissions-sync', source: 'epa-nei', year: 2023, ...(options.state ? { state: options.state } : {}) };
    case 'emissions-npri': return { schemaVersion, kind: 'emissions-sync', source: 'npri', startYear: 2023, endYear: 2023, maxReports: 20 };
    case 'ground-evidence': return { ...base, records: [] };
    case 'grid': return { ...base, source: 'power-grid', variables: ['T2M'], date: `${selected}-07` };
    case 'sync': return { ...base, variables: ['T2M', 'PRECTOTCORR'], maxCacheMiB: 64 };
    default: throw new Error('Unknown environmental operation.');
  }
}

/** Preserve distinct model/parameter/unit series; nulls are never converted to zero. */
export function environmentSeries(result) {
  const output = [];
  const add = (item, model) => {
    if (!Array.isArray(item.series)) return;
    output.push({ id: String(item.id ?? item.variable), label: item.label || item.id || item.variable, unit: item.unit ?? item.units ?? 'unit not supplied', model,
      points: item.series.map((p) => ({ date: String(p.date), value: validNumber(p.value) ? p.value : null })) });
  };
  for (const v of result?.variables || []) add(v);
  if (Array.isArray(result?.metrics)) for (const v of result.metrics) add(v);
  for (const model of result?.models || []) for (const metric of model.metrics || []) add(metric, model.model);
  const water = new Map();
  for (const r of result?.records || []) {
    if (!r.parameterCode) continue;
    const key = JSON.stringify([r.parameterCode, r.unit, r.timeSeriesId]);
    if (!water.has(key)) water.set(key, { id: r.parameterCode, label: r.parameterName || r.parameterCode, unit: r.unit ?? 'unit not supplied', points: [], sourceSeriesId: r.timeSeriesId });
    water.get(key).points.push({ date: r.sourceTime || r.date, value: r.valueStatus === 'numeric' && validNumber(r.value) ? r.value : null });
  }
  output.push(...water.values());
  return output;
}

export function waterStations(result) {
  const s = result?.station, p = s?.location;
  return p && validNumber(p.latitude) && validNumber(p.longitude) ? [{ id: s.id, name: s.name || s.id, lat: p.latitude, lon: p.longitude, sourceUrl: s.sourceUrl, evidence: result.evidence, parameters: result.parameters || [] }] : [];
}

export function climateRows(result, metric = 'meanTempC', scenario = 'ssp245') {
  const m = result?.metrics?.[metric];
  if (!m) return [];
  return [['historical_1995_2014', 'Baseline · 1995–2014'], [`${scenario}_2041_2060`, 'Mid century · 2041–2060'], [`${scenario}_2081_2100`, 'Late century · 2081–2100']].map(([key, label]) => {
    const row = m[key], value = row?.value || row;
    return { key, label, unit: m.unit, median: validNumber(value?.median) ? value.median : null, min: validNumber(value?.min) ? value.min : null, max: validNumber(value?.max) ? value.max : null, models: value?.models ?? null, change: row?.changeFromHistorical || null };
  });
}

export function createStaticEnvironment({ fetchImpl = globalThis.fetch, dataBase = 'data' } = {}) {
  const cache = new Map();
  const load = async (path, schema) => {
    if (!cache.has(path)) cache.set(path, (async () => {
      const response = await fetchImpl(`${dataBase}/${path}`);
      if (!response.ok) throw new Error(response.status === 404 ? 'No prepared product for this location.' : `Prepared product HTTP ${response.status}`);
      const data = await response.json();
      if (data.schemaVersion !== schema) throw new Error('Unsupported environmental product format.');
      return data;
    })().catch((error) => { cache.delete(path); throw error; }));
    return cache.get(path);
  };
  const id = (siteId) => { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(siteId)) throw new Error('Invalid site ID.'); return siteId; };
  return { climate: (siteId) => load(`projections/${id(siteId)}.json`, 'climate-projection/1.0'), plume: (siteId) => load(`plumes/${id(siteId)}.json`, 'plume-scenario/1.0'), clear: () => cache.clear() };
}

/** Monitoring-location discovery is separate from actual parameter/time coverage. */
export function createWaterStationLookup({ fetchImpl = globalThis.fetch, url = '/api/water-stations' } = {}) {
  const cache = new Map();
  return async (site, signal) => {
    const point = sitePoint(site), key = `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
    if (cache.has(key)) return cache.get(key);
    const response = await fetchImpl(`${url}?${new URLSearchParams({ lat: point.latitude, lon: point.longitude })}`, { signal });
    if (!response.ok) throw new Error('Nearby station search is unavailable. You can enter a sourced USGS station ID in the source options.');
    const result = await response.json();
    if (!Array.isArray(result.stations)) throw new Error('Station search returned no usable location list.');
    const distance = (s) => {
      const radians = Math.PI / 180, a = Math.sin((s.lat - point.latitude) * radians / 2) ** 2 + Math.cos(point.latitude * radians) * Math.cos(s.lat * radians) * Math.sin((s.lon - point.longitude) * radians / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    };
    const value = { ...result, stations: result.stations.filter((s) => /^USGS-\d{8,15}$/.test(s.id) && validNumber(s.lat) && validNumber(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180).map((s) => ({ ...s, distanceKm: distance(s) })).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 50) };
    cache.set(key, value); if (cache.size > 12) cache.delete(cache.keys().next().value);
    return value;
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const CACHE_KEY = 'footprint.environment.runs.v1';
const aborted = () => new DOMException('Stopped watching this run. The server may finish it in the background.', 'AbortError');
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const stop = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Local job API with bounded references, terminal polling, and observer-only cancellation. */
export function createEnvironmentClient({ baseUrl = 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch, storage, pollMs = 1500, maxWaitMs = 25 * 60000, now = Date.now, sleep = pause } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const memory = new Map();
  let refs = [];
  try { refs = JSON.parse(storage?.getItem(CACHE_KEY) || '[]'); if (!Array.isArray(refs)) refs = []; } catch { refs = []; }
  refs = refs.filter((r) => typeof r?.id === 'string' && typeof r.key === 'string' && r.base === base && now() - r.savedAt < 30 * 86400000).slice(-20);
  const remember = (ref) => { refs = refs.filter((r) => r.id !== ref.id && r.key !== ref.key); refs.push({ ...ref, base, savedAt: now() }); refs = refs.slice(-20); try { storage?.setItem(CACHE_KEY, JSON.stringify(refs)); } catch { /* storage is optional */ } };
  async function request(path, { signal, ...options } = {}) {
    // No result URL supplied by an upstream response is followed off the configured API.
    if (!/^\/(health|v1(?:\/|$))/.test(path)) throw new Error('Invalid environmental API path.');
    const timeout = AbortSignal.timeout(30000);
    const response = await fetchImpl(`${base}${path}`, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let data; try { data = await response.json(); } catch { throw new Error(`Environmental API returned HTTP ${response.status} without JSON.`); }
    if (!response.ok) { const error = new Error(data?.error?.message || `Environmental API HTTP ${response.status}`); error.status = response.status; error.details = data?.error?.details; throw error; }
    return data;
  }
  const status = (id, signal) => request(`/v1/runs/${encodeURIComponent(id)}`, { signal });
  async function result(id, signal) {
    if (memory.has(id)) return memory.get(id);
    const value = await request(`/v1/runs/${encodeURIComponent(id)}/results`, { signal });
    memory.set(id, value); if (memory.size > 5) memory.delete(memory.keys().next().value);
    return value;
  }
  async function run(payload, { signal, onProgress = () => {}, reuse = true, context = {} } = {}) {
    if (!payload || payload.schemaVersion !== '1.0' || !ENVIRONMENT_ACTIONS.some(([id]) => id === payload.kind || (id.startsWith('emissions-') && payload.kind === 'emissions-sync'))) throw new Error('Choose a supported environmental operation.');
    const key = stable(payload), previous = reuse ? refs.find((r) => r.key === key) : null;
    let run;
    if (previous) {
      try { run = await status(previous.id, signal); } catch (error) { if (signal?.aborted || error.status !== 404) throw error; }
      if (run?.status === 'failed') run = null;
    }
    if (!run) run = await request('/v1/runs', { method: 'POST', body: JSON.stringify(payload), signal });
    remember({ id: run.id, key, kind: payload.kind, siteId: context.siteId, status: run.status });
    const begun = now();
    while (true) {
      if (signal?.aborted) throw aborted();
      onProgress(run);
      if (run.status === 'completed') {
        const value = await result(run.id, signal);
        remember({ id: run.id, key, kind: payload.kind, siteId: context.siteId, status: 'completed' });
        return { run, result: value, reused: !!previous };
      }
      if (run.status === 'failed') throw new Error(run.error?.message || 'Environmental run failed.');
      if (!['queued', 'running'].includes(run.status)) throw new Error('Environmental API returned an unknown run state.');
      if (now() - begun >= maxWaitMs) throw new Error('Stopped watching after the time limit. Re-run the same request to reconnect to the saved job.');
      await sleep(pollMs, signal); run = await status(run.id, signal);
    }
  }
  return { baseUrl: base, request, run, status, result, history: () => refs.map((r) => ({ ...r })),
    discover: async (signal) => {
      const [health, domains, sources] = await Promise.all([request('/health', { signal }), request('/v1/domains', { signal }), request('/v1/sources', { signal })]);
      if (health.status !== 'ok') throw new Error('Environmental API is not ready.');
      return { health, domains: domains.domains || [], sources: sources.sources || [] };
    },
    browse: (kind, filters = {}, signal) => {
      if (!['facilities', 'emissions'].includes(kind)) throw new Error('Unknown source library.');
      return request(`/v1/${kind}?${new URLSearchParams(Object.entries({ limit: 20, ...filters }).filter(([, v]) => v !== '' && v != null))}`, { signal });
    },
  };
}
