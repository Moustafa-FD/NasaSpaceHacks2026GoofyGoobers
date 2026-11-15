import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEnvironmentRequest } from '../packages/contracts/src/environment.ts';
import { ENVIRONMENT_ACTIONS, buildEnvironmentRequest, climateRows, createEnvironmentClient, createStaticEnvironment, createWaterStationLookup, environmentSeries, waterStations } from '../apps/web/js/environment-data.js';

const site = { id: 'ashburn', name: 'Ashburn', lat: 39.0298, lon: -77.4744 };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const memoryStorage = () => { const data = new Map(); return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) }; };

test('guided requests obey the actual API contract, including source units and bounded dates', () => {
  for (const [action] of ENVIRONMENT_ACTIONS) {
    if (action === 'ground-evidence') continue; // Explicit user records, never fabricated defaults.
    const q = buildEnvironmentRequest(action, site, 2025, { stationId: 'USGS-01646500', runId: 'completed-run', variable: 'T2M', state: 'VA' });
    assert.deepEqual(validateEnvironmentRequest(q), [], `${action}: ${JSON.stringify(q)}`);
  }
  const weather = buildEnvironmentRequest('series', site, 2090);
  assert.equal(weather.start, '1991-01'); assert.equal(weather.end, '2020-12');
  assert.deepEqual(weather.point, { latitude: site.lat, longitude: site.lon });
  assert.throws(() => buildEnvironmentRequest('air-quality', site, 2018), /starts in August 2022/);
  const air = buildEnvironmentRequest('air-quality', site, 2022); assert.equal(air.start, '2022-08-01'); assert.equal(air.end, '2022-08-07');
  const point = buildEnvironmentRequest('plume-scenario', { ...site, id: 'clicked-point' });
  assert.ok(point.point); assert.equal(point.siteId, undefined); assert.equal(point.emission, undefined); assert.equal(point.effectiveHeightM, 20);
  assert.throws(() => buildEnvironmentRequest('series', { ...site, lat: NaN }), /valid map/);
});

test('all five prepared climate products retain source baseline, sampled windows and paired-model deltas', () => {
  for (const id of ['ashburn', 'colossus1', 'colossus2', 'abilene', 'thedalles']) {
    const d = JSON.parse(readFileSync(new URL(`../data/cloudshadow/projections/${id}.json`, import.meta.url)));
    for (const metric of ['meanTempC', 'hotDays35C', 'precipMmPerYear']) for (const pathway of ['ssp245', 'ssp585']) {
      const rows = climateRows(d, metric, pathway);
      assert.equal(rows.length, 3); assert.equal(rows[0].median, d.metrics[metric].historical_1995_2014.median);
      assert.deepEqual(rows[1].change, d.metrics[metric][`${pathway}_2041_2060`].changeFromHistorical);
      assert.equal(rows[2].unit, d.metrics[metric].unit); assert.ok(rows.every((r) => r.min <= r.median && r.median <= r.max));
    }
  }
  assert.deepEqual(climateRows({}, 'absent'), []);
});

test('series normalization preserves models, POWER-grid metrics, units, nulls and censored observations', () => {
  const d = { variables: [{ id: 'T2M', unit: 'C', series: [{ date: '2020-01', value: null }, { date: '2020-02', value: 0 }] }], metrics: [{ variable: 'WS2M', units: 'm/s', series: [{ date: '2020-01', value: 3 }] }], models: [{ model: 'ERA5', metrics: [{ id: 'soil_moisture', units: 'm³/m³', series: [{ date: '2020-01-01', value: .2 }] }] }], records: [{ parameterCode: '00400', parameterName: 'pH', unit: 'pH', timeSeriesId: 'one', date: '2020-01-01', value: 7, valueStatus: 'numeric' }, { parameterCode: '00400', unit: 'pH', timeSeriesId: 'one', date: '2020-01-02', value: 6, valueStatus: 'censored' }, { parameterCode: '00400', unit: 'different', timeSeriesId: 'two', date: '2020-01-02', value: null, valueStatus: 'missing_or_non_numeric' }] };
  const all = environmentSeries(d); assert.equal(all.length, 5); assert.equal(all[1].id, 'WS2M'); assert.equal(all[1].unit, 'm/s');
  assert.equal(all[2].model, 'ERA5'); assert.deepEqual(all[0].points.map((p) => p.value), [null, 0]); assert.deepEqual(all[3].points.map((p) => p.value), [7, null]);
  assert.deepEqual(waterStations({ station: { id: 'USGS-x', location: null } }), []);
  const stations = waterStations({ station: { id: 'USGS-01646500', name: 'Source station', location: { latitude: 39, longitude: -77 }, sourceUrl: 'https://waterdata.usgs.gov/' }, evidence: 'ground-observation' });
  assert.deepEqual(stations[0].lat, 39); assert.equal(stations[0].evidence, 'ground-observation');
});

test('prepared products are cached, schema checked and failed loads remain retryable', async () => {
  let calls = 0;
  const d = { schemaVersion: 'climate-projection/1.0', site: { id: site.id } };
  const products = createStaticEnvironment({ fetchImpl: async () => { calls++; return response(d); } });
  const [a, b] = await Promise.all([products.climate('ashburn'), products.climate('ashburn')]); assert.equal(a, b); assert.equal(calls, 1);
  assert.throws(() => products.climate('../secrets'), /Invalid site/);
  const missing = createStaticEnvironment({ fetchImpl: async () => { calls++; return response({}, 404); } });
  await assert.rejects(missing.plume('ashburn'), /No prepared product/); await assert.rejects(missing.plume('ashburn'), /No prepared product/); assert.equal(calls, 3);
  await assert.rejects(createStaticEnvironment({ fetchImpl: async () => response({ schemaVersion: 'wrong' }) }).climate('ashburn'), /Unsupported/);
});

test('live jobs follow queued/running/completed states once and reuse persisted references', async () => {
  const storage = memoryStorage(), calls = [], statuses = [];
  let polls = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    if (options.method === 'POST') return response({ id: 'run-1', status: 'queued', resultUrl: 'https://invalid.example/steal' }, 202);
    if (url.endsWith('/results')) return response({ kind: 'series', evidence: 'model-derived', variables: [] });
    return response({ id: 'run-1', status: ++polls > 1 ? 'completed' : 'running', progress: 50 });
  };
  const q = buildEnvironmentRequest('series', site), client = createEnvironmentClient({ baseUrl: '/api/environment', storage, fetchImpl, sleep: async () => {} });
  const first = await client.run(q, { context: { siteId: site.id }, onProgress: (r) => statuses.push(r.status) });
  assert.deepEqual(statuses, ['queued', 'running', 'completed']); assert.equal(first.result.evidence, 'model-derived'); assert.equal(first.reused, false);
  const restored = createEnvironmentClient({ baseUrl: '/api/environment', storage, fetchImpl, sleep: async () => {} });
  assert.equal((await restored.run(q)).reused, true); assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  assert.ok(calls.every(([url]) => url.startsWith('/api/environment/v1/'))); assert.equal(restored.history()[0].siteId, undefined, 'context is not invented during a generic reload');
});

test('failed runs, validation errors, timeout and cancellation terminate browser polling', async () => {
  const q = buildEnvironmentRequest('series', site); let requests = 0;
  const failed = createEnvironmentClient({ fetchImpl: async (_url, opts) => { requests++; return response(opts.method === 'POST' ? { id: 'failed', status: 'queued' } : { id: 'failed', status: 'failed', error: { message: 'Actual source unavailable' } }); }, sleep: async () => {} });
  await assert.rejects(failed.run(q), /Actual source unavailable/); assert.equal(requests, 2);
  const invalid = createEnvironmentClient({ fetchImpl: async () => response({ error: { message: 'Invalid dates', details: ['ordered dates required'] } }, 422) });
  await assert.rejects(invalid.run(q), (e) => e.status === 422 && e.details[0] === 'ordered dates required');
  let time = 0;
  const timed = createEnvironmentClient({ maxWaitMs: 1, now: () => time++, fetchImpl: async () => response({ id: 'waiting', status: 'running' }), sleep: async () => {} });
  await assert.rejects(timed.run(q), /time limit/);
  const controller = new AbortController();
  const canceled = createEnvironmentClient({ fetchImpl: async () => response({ id: 'waiting', status: 'queued' }), sleep: async () => controller.abort() });
  await assert.rejects(canceled.run(q, { signal: controller.signal }), { name: 'AbortError' });
});

test('run history stays bounded and facility browsing preserves source filters', async () => {
  const storage = memoryStorage(); let id = 0, browseUrl;
  const client = createEnvironmentClient({ storage, fetchImpl: async (url, options = {}) => {
    if (url.includes('/facilities?')) { browseUrl = url; return response({ records: [], total: 0 }); }
    return response(options.method === 'POST' ? { id: `run-${++id}`, status: 'completed' } : { kind: 'series' });
  } });
  for (let i = 0; i < 25; i++) await client.run({ ...buildEnvironmentRequest('series', site), point: { latitude: i, longitude: -77 } });
  assert.equal(client.history().length, 20);
  await client.browse('facilities', { source: 'osm', bbox: '-78,38,-77,39', q: 'source name' });
  assert.ok(browseUrl.includes('source=osm')); assert.ok(browseUrl.includes('q=source+name')); assert.ok(browseUrl.includes('limit=20'));
});

test('station discovery keeps actual valid coordinates, distance ordering, warnings and bounded cached lookups', async () => {
  let calls = 0;
  const find = createWaterStationLookup({ fetchImpl: async (url) => { calls++; assert.match(url, /^\/api\/water-stations\?lat=/); return response({ stations: [{ id: 'USGS-01646500', name: 'Farther', lat: 39.1, lon: -77.5 }, { id: 'USGS-12345678', name: 'Nearer', lat: site.lat, lon: site.lon }, { id: 'invented', lat: 0, lon: 0 }], warnings: ['Parameter coverage unknown'] }); } });
  const result = await find(site); assert.equal(result.stations.length, 2); assert.equal(result.stations[0].id, 'USGS-12345678'); assert.equal(result.stations[0].distanceKm, 0); assert.equal(result.warnings[0], 'Parameter coverage unknown');
  assert.equal(await find(site), result); assert.equal(calls, 1);
  await assert.rejects(createWaterStationLookup({ fetchImpl: async () => response({}, 503) })(site), /unavailable/);
});
