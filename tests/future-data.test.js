import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachFutureData, futureProductMatchesSite, summarizeDailyClimateYear, summarizeFutureClimate, summarizeFutureProduct, summarizeFutureTrend } from '../apps/web/js/future-data.js';
import { buildEnvironmentRequest, futureRequestPeriod } from '../apps/web/js/environment-data.js';
import { validateEnvironmentRequest } from '../packages/contracts/src/environment.ts';
const product = (id = 'thedalles') => JSON.parse(readFileSync(new URL(`../data/cloudshadow/projections/${id}.json`, import.meta.url)));
const site = { id: 'thedalles', name: 'The Dalles', lat: 45.6241, lon: -121.2071 };
const emit = (target, type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('future summaries expose actual five-site climate values, paired-model deltas and explicit source periods', () => {
  for (const id of ['ashburn', 'abilene', 'colossus1', 'colossus2', 'thedalles']) for (const scenario of ['ssp245', 'ssp585']) for (const metric of ['meanTempC', 'hotDays35C', 'precipMmPerYear']) {
    const raw = product(id), summary = summarizeFutureClimate(raw, { year: 2090, scenario, metric }), row = raw.metrics[metric][`${scenario}_2081_2100`];
    assert.equal(summary.value, row.value.median); assert.equal(summary.min, row.value.min); assert.equal(summary.max, row.value.max); assert.equal(summary.change.median, row.changeFromHistorical.median);
    assert.equal(summary.baseline.value, raw.metrics[metric].historical_1995_2014.median); assert.deepEqual(summary.period, { start: 2081, end: 2100, label: '2081–2100' }); assert.equal(summary.periodContainsYear, true); assert.equal(summary.source.name, 'NASA NEX-GDDP-CMIP6');
  }
  const gap = summarizeFutureClimate(product(), { year: 2030 }); assert.equal(gap.period.label, '2041–2060'); assert.equal(gap.periodContainsYear, false);
  assert.equal(summarizeFutureClimate(product(), { year: 2071 }).period.label, '2081–2100');
  assert.equal(summarizeFutureClimate(product(), { year: 2101 }).available, false);
  assert.equal(summarizeFutureClimate(product(), { year: 2050, scenario: 'invented' }).available, false);
});

test('future summaries keep real zero and missing model outputs distinct without manufacturing annual climate values', () => {
  const raw = product(); raw.metrics.meanTempC.ssp245_2041_2060.value.median = 0; raw.metrics.meanTempC.ssp245_2041_2060.changeFromHistorical.median = 0;
  assert.equal(summarizeFutureClimate(raw, { year: 2050 }).value, 0); assert.equal(summarizeFutureClimate(raw, { year: 2050 }).change.median, 0);
  raw.metrics.meanTempC.ssp245_2041_2060.value.median = null;
  assert.equal(summarizeFutureClimate(raw, { year: 2050 }).value, null); assert.equal(summarizeFutureClimate(raw, { year: 2050 }).available, false);
  assert.equal(summarizeFutureProduct('climate-projection', product(), { year: 2050 }).metrics.precipMmPerYear.available, true);
});

test('agriculture keeps independent per-model changes, explicit supported periods and null season coverage', () => {
  const raw = { futurePeriod: { start: '2045-01-01', end: '2049-12-31' }, comparisons: [{ indicators: { heatThresholdDays: { baselineMeanPerSeason: 0, futureMeanPerSeason: 12, change: 12 }, dryThresholdDays: { baselineMeanPerSeason: null, futureMeanPerSeason: null, change: null } } }] };
  const summary = summarizeFutureProduct('agriculture', raw, { year: 2090 });
  assert.equal(summary.metrics.heatThresholdDays.baseline.value, 0); assert.equal(summary.metrics.heatThresholdDays.value, 12); assert.equal(summary.metrics.dryThresholdDays.value, null); assert.equal(summary.metrics.dryThresholdDays.available, false); assert.equal(summary.period.end, '2049-12-31');
});

test('source-backed future trend rows remain conditional, bounded to 2035 and preserve zero/bands', () => {
  const raw = { lastObservedYear: 2026, rows: [{ Year: 2030, Phase: 'projected', NDVI_Site: 0, NDVI_SiteLo: -.1, NDVI_SiteHi: .2, NDVI_Local: -.02, NDVI_LocalLo: -.04, NDVI_LocalHi: .03 }, { Year: 2036, Phase: 'projected', NDVI_Site: 99 }] };
  const summary = summarizeFutureTrend(raw, { year: 2030, variable: 'NDVI' });
  assert.equal(summary.available, true); assert.equal(summary.value, 0); assert.equal(summary.unit, 'NDVI'); assert.equal(summary.local, -.02); assert.equal(summary.localMax, .03); assert.equal(summary.variables.NO2.available, false);
  assert.equal(summarizeFutureTrend(raw, { year: 2036, variable: 'NDVI' }).available, false);
});

test('daily climate summaries require complete model years, use actual model forcing and retain missing-model coverage', () => {
  const dates = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2028, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const data = { evidence: 'climate-scenario', scenario: 'HighResMIP high forcing', models: [{ model: 'complete', metrics: [{ id: 'temperature_2m_mean', units: '°C', series: dates.map((date) => ({ date, value: 0 })) }, { id: 'temperature_2m_max', units: '°C', series: dates.map((date, i) => ({ date, value: i < 2 ? 35 : 34 })) }, { id: 'precipitation_sum', units: 'mm', series: dates.map((date) => ({ date, value: 1 })) }] }, { model: 'missing', metrics: [{ id: 'precipitation_sum', units: 'mm', series: dates.slice(1).map((date) => ({ date, value: 1 })) }] }] };
  assert.equal(summarizeDailyClimateYear(data, { year: 2028 }).value, 0);
  assert.equal(summarizeDailyClimateYear(data, { year: 2028, metric: 'hotDays35C' }).value, 2);
  const rain = summarizeDailyClimateYear(data, { year: 2028, metric: 'precipMmPerYear' });
  assert.equal(rain.value, 366); assert.equal(rain.models, 1); assert.equal(rain.requestedModels, 2); assert.equal(rain.perModel[1].available, false); assert.equal(rain.scenario, 'HighResMIP high forcing');
  assert.equal(summarizeDailyClimateYear(data, { year: 2029 }).available, false);
  assert.equal(summarizeFutureProduct('climate', data, { year: 2028 }).metrics.precipMmPerYear.value, 366);
  data.models[0].metrics[2].series[0].value = null; assert.equal(summarizeDailyClimateYear(data, { year: 2028, metric: 'precipMmPerYear' }).value, null);
});

test('one shared future state consumes prepared/API results, updates scenario/year and ignores wrong-site publications', async () => {
  const target = new EventTarget(), updates = []; target.addEventListener('cs:future-state', ({ detail }) => updates.push(detail.state));
  const bridge = attachFutureData({ site, year: 2050, eventTarget: target, fetchImpl: null });
  emit(target, 'cs:environment-data', { siteId: site.id, kind: 'climate-projection', result: product() });
  assert.equal(bridge.state.climate.period.start, 2041); assert.equal(bridge.state.products['climate-projection'].site.id, site.id);
  emit(target, 'cs:future-options', { scenario: 'ssp585' }); assert.equal(bridge.state.climate.scenario, 'ssp585');
  emit(target, 'cs:year', { siteId: site.id, year: 2090 }); assert.equal(bridge.state.climate.period.start, 2081);
  emit(target, 'cs:future-view', { group: 'water' }); assert.equal(bridge.state.group, 'water');
  const count = updates.length; emit(target, 'cs:future-options', { scenario: 'ssp585' }); assert.equal(updates.length, count, 'unchanged options cannot cause render/event recursion');
  await bridge.setSite({ ...site, id: 'ashburn' }); assert.equal(bridge.state.climate, null);
  emit(target, 'cs:environment-data', { siteId: site.id, kind: 'climate-projection', result: product() }); assert.equal(bridge.state.climate, null);
  emit(target, 'cs:environment-data', { siteId: 'ashburn', kind: 'climate-projection', result: product() }); assert.equal(bridge.state.climate, null, 'mismatched product identity rejected');
  bridge.destroy(); const after = updates.length; emit(target, 'cs:year', { year: 2050 }); assert.equal(updates.length, after);
});

test('live generic-point climate outputs bind to matching requested coordinates without changing source identity', async () => {
  const raw = product(); raw.site = { ...raw.site, id: 'point' };
  assert.equal(futureProductMatchesSite(raw, site), true);
  const clicked = { ...site, id: 'point-45.6241,-121.2071' };
  assert.equal(futureProductMatchesSite(raw, clicked), true);
  assert.equal(futureProductMatchesSite(raw, { ...clicked, lat: clicked.lat + .001 }), false);
  assert.equal(futureProductMatchesSite({ ...raw, site: { id: 'point' } }, site), false);
  assert.equal(futureProductMatchesSite({ ...raw, site: { ...raw.site, id: site.id, lon: site.lon + .01 } }, site), false);
  assert.equal(futureProductMatchesSite({ ...raw, site: { ...raw.site, id: 'ashburn' } }, site), false);
  assert.equal(futureProductMatchesSite({ requestedPoint: { latitude: site.lat, longitude: site.lon }, sourcePoint: { latitude: site.lat + .1, longitude: site.lon + .1 } }, site), true);
  assert.equal(futureProductMatchesSite({ requestedPoint: { latitude: site.lat + .1, longitude: site.lon } }, site), false);
  const target = new EventTarget(), bridge = attachFutureData({ site, year: 2050, eventTarget: target, fetchImpl: null });
  emit(target, 'cs:environment-data', { siteId: site.id, kind: 'climate-projection', result: raw });
  assert.equal(bridge.state.climate.available, true); assert.equal(bridge.state.products['climate-projection'].site.id, 'point');
  await bridge.setSite(clicked);
  emit(target, 'cs:environment-data', { siteId: clicked.id, kind: 'climate-projection', result: raw });
  assert.equal(bridge.state.climate.available, true);
  const before = bridge.state.products['climate-projection'];
  emit(target, 'cs:environment-data', { siteId: clicked.id, kind: 'climate-projection', result: { ...raw, site: { ...raw.site, lon: site.lon + .1 } } });
  assert.equal(bridge.state.products['climate-projection'], before);
  bridge.destroy();
});

test('shared future bridge loads bounded local trends, rejects late site loads and invokes Node-backed actions once', async () => {
  const target = new EventTarget(), calls = [], loads = new Map(); let resolveJob;
  const bridge = attachFutureData({ site, year: 2030, eventTarget: target, fetchImpl: (url) => new Promise((resolve) => loads.set(url, resolve)), onRequest: (kind, options) => { calls.push([kind, options]); return new Promise((resolve) => { resolveJob = resolve; }); } });
  const switched = bridge.setSite({ ...site, id: 'ashburn' });
  loads.get('data/unreal/timeline/thedalles.json')({ ok: true, json: async () => ({ site: site.id, rows: [{ Year: 2030, Phase: 'projected', LST_Day_Site: 999 }] }) });
  loads.get('data/unreal/timeline/ashburn.json')({ ok: true, json: async () => ({ site: 'ashburn', rows: [{ Year: 2030, Phase: 'projected', LST_Day_Site: 20 }] }) });
  await switched; await tick(); assert.equal(bridge.state.trend.value, 20);
  const running = bridge.request('plume-scenario'); await bridge.request('plume-scenario'); assert.equal(calls.length, 1); assert.equal(calls[0][1].year, 2030); assert.equal(bridge.state.pending, true);
  resolveJob({ result: { site: { id: 'ashburn' }, grid: { values: [[0, 1], [1, 0]], units: 's/m³' }, evidence: 'scenario' } });
  await running; assert.equal(bridge.state.pending, false); assert.equal(bridge.state.plume.available, true);
  assert.equal(bridge.state.plume.annualForecast, false);
  bridge.destroy();
});

test('completed jobs for a mismatched location produce an error instead of a false ready state', async () => {
  const raw = product(); raw.site = { id: 'point', lat: site.lat + 1, lon: site.lon };
  const bridge = attachFutureData({ site, year: 2050, eventTarget: new EventTarget(), fetchImpl: null, onRequest: async () => ({ result: raw }) });
  await bridge.request('climate-projection');
  assert.match(bridge.state.error, /does not match/); assert.equal(bridge.state.climate, null); assert.equal(bridge.state.pending, false); assert.equal(bridge.state.status, 'Model output unavailable.'); bridge.destroy();
});

test('future model requests use selected bounded source periods and never silently clamp a 2100 request', () => {
  const now = new Date('2026-11-15T12:00Z');
  assert.deepEqual(futureRequestPeriod(2049, now), { start: '2045-01-01', end: '2049-12-31' });
  for (const year of [2030, 2040, 2049]) for (const kind of ['climate', 'agriculture']) assert.deepEqual(validateEnvironmentRequest(buildEnvironmentRequest(kind, site, year, { now })), []);
  assert.throws(() => buildEnvironmentRequest('agriculture', site, 2090, { now }), /through 2049/);
  assert.equal(buildEnvironmentRequest('agriculture', site, 2040, { now }).future.end, '2040-12-31');
});
