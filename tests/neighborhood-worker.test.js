import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNeighborhoodWorker } from '../apps/web/js/neighborhood-worker.js';
import { buildNeighborhoodGlb, planNeighborhood, readGlb } from '../apps/web/js/neighborhood-core.js';

const assets = Promise.all(['manifest.json', 'kit.glb'].map((name) => readFile(new URL('../apps/web/assets/low-poly/' + name, import.meta.url))))
  .then(([manifest, kit]) => ({ manifest: JSON.parse(manifest), kit: kit.buffer.slice(kit.byteOffset, kit.byteOffset + kit.byteLength) }));
const snapshot = { schemaVersion: 1, status: 'ready', siteId: 'worker-test', center: { lat: 35, lon: -90 }, radiusM: 100,
  buildings: [{ id: 'house', type: 'house', polygon: [[-40,-40],[-25,-40],[-25,-25],[-40,-25],[-40,-40]], tags: { building: 'house' } }], areas: [], trees: [], roads: [
    { id: 'way/oneway', kind: 'residential', width: 6, widthSource: 'osm:width', tags: { oneway: 'yes' }, points: [[-80,0],[0,0],[80,0]] },
    { id: 'way/branch', kind: 'service', width: 4, widthSource: 'osm:width', points: [[0,0],[0,80]] },
  ] };
const options = { maxBuildings: 10, maxTrees: 0, maxCrops: 0, maxGrass: 0, maxInfillBuildings: 0 };
const request = (id, progressive = false) => ({ id, snapshot, options, progressive });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness(overrides = {}) {
  const posted = [], sourceBuffers = [], builds = [], plans = [], events = [];
  let kitLoads = 0;
  const worker = createNeighborhoodWorker({
    loadAssets: async () => { kitLoads++; return assets; },
    plan: (...args) => { plans.push(args[2]); events.push('plan'); return planNeighborhood(...args); },
    build: (...args) => {
      const stage = args[3].preview ? 'preview' : args[3].detail === 'overview' ? 'overview' : 'detail';
      builds.push({ stage, options: args[3] }); events.push('build:' + stage);
      const result = buildNeighborhoodGlb(...args); sourceBuffers.push(result.buffer); return result;
    },
    postMessage: (message, transfer) => { events.push('post:' + (message.stage || 'error')); posted.push(structuredClone(message, { transfer })); },
    ...overrides,
  });
  return { worker, posted, sourceBuffers, builds, plans, events, get kitLoads() { return kitLoads; } };
}
function validGlb(buffer) {
  const view = new DataView(buffer); assert.equal(view.getUint32(0, true), 0x46546c67); assert.equal(view.getUint32(8, true), buffer.byteLength);
  const { json, bin } = readGlb(buffer); assert.ok(json.scenes[0].nodes.length > 0);
  for (const v of json.bufferViews) assert.ok((v.byteOffset || 0) + v.byteLength <= bin.byteLength);
  return json;
}

test('nonprogressive worker transfers close then overview, reuses one plan and kit, and preserves shared graph references', async () => {
  const h = harness(); await h.worker.handle(request(1));
  assert.deepEqual(h.posted.map((m) => m.stage), ['detail', 'complete']);
  assert.equal(h.plans.length, 1); assert.equal(h.builds[0].options.preparedPlan, h.builds[1].options.preparedPlan);
  assert.ok(h.sourceBuffers.every((b) => b.byteLength === 0), 'both buffers transfer ownership rather than cloning bytes');
  const scene = h.posted[0].result, complete = h.posted[1].result, graph = scene.trafficGraph;
  validGlb(scene.buffer); validGlb(complete.overviewBuffer);
  assert.equal(scene.stage, 'detail'); assert.equal(scene.overviewBuffer, undefined); assert.equal(complete.trafficGraph, undefined); assert.equal(complete.buffer, undefined);
  assert.equal(complete.compileStats.planningPasses, 1); assert.equal(complete.compileStats.previewMs, 0);
  for (const key of ['planningMs', 'detailMs', 'overviewMs', 'totalMs']) assert.ok(Number.isFinite(complete.compileStats[key]) && complete.compileStats[key] >= 0);
  assert.ok(complete.compileStats.unusedAssetBytesRemoved > 1000000);
  assert.ok(graph.arcs.length >= 3); assert.ok(graph.byRoad instanceof Map); assert.ok(graph.locks instanceof Map);
  assert.ok(graph.byRoad.get('way/oneway').every((arc) => arc.sourceDirection === 1 && graph.arcs[arc.id] === arc));
  assert.ok(graph.byRoad.get('way/branch').length >= 2); assert.ok(graph.nodes.some((node) => node.out.length > 1));
  assert.ok(graph.stats.sourceSegments < scene.roadPaths.reduce((n, path) => n + path.points.length - 1, 0));
  graph.locks.set(0, 123); await h.worker.handle(request(2));
  assert.equal(h.posted[2].result.trafficGraph.locks.size, 0); assert.equal(h.kitLoads, 1);
});

test('progressive preview is transferred before full planning and the next task builds detail before overview', async () => {
  const reached = deferred(), resume = deferred(); let boundaries = 0;
  const h = harness({ taskBoundary: async () => { if (++boundaries === 1) { reached.resolve(); await resume.promise; } } });
  const done = h.worker.handle(request(3, true)); await reached.promise;
  assert.deepEqual(h.posted.map((m) => m.stage), ['preview']); assert.equal(h.plans.length, 0);
  const preview = h.posted[0].result; validGlb(preview.buffer); assert.equal(preview.stage, 'preview'); assert.equal(preview.trafficGraph, undefined);
  const o = h.builds[0].options; assert.equal(o.preview, true); assert.equal(o.detail, 'overview'); assert.equal(o.terrainSpacingM, 150);
  assert.equal(o.maxInfillBuildings + o.maxTrees + o.maxCrops, 0);
  resume.resolve(); await done;
  assert.deepEqual(h.posted.map((m) => m.stage), ['preview', 'detail', 'complete']);
  assert.deepEqual(h.events, ['build:preview','post:preview','plan','build:detail','post:detail','build:overview','post:complete']);
  assert.equal(boundaries, 2); assert.equal(h.plans.length, 1); assert.equal(h.builds[1].options.preparedPlan, h.builds[2].options.preparedPlan);
  validGlb(h.posted[1].result.buffer); validGlb(h.posted[2].result.overviewBuffer);
  assert.ok(h.sourceBuffers.every((b) => b.byteLength === 0)); assert.ok(h.posted[2].result.compileStats.previewMs >= 0);
});

test('cancelling after preview suppresses expensive planning and all later stages', async () => {
  let h; h = harness({ taskBoundary: async () => { await h.worker.handle({ id: 4, cancel: true }); } });
  await h.worker.handle(request(4, true));
  assert.deepEqual(h.posted.map((m) => m.stage), ['preview']); assert.equal(h.plans.length, 0); assert.equal(h.builds.length, 1);
  await h.worker.handle(request(5)); assert.deepEqual(h.posted.filter((m) => m.id === 5).map((m) => m.stage), ['detail', 'complete']);
});

test('cancelling after detail keeps its usable buffer while suppressing overview work', async () => {
  let h; h = harness({ taskBoundary: async () => { await h.worker.handle({ id: 6, cancel: true }); } });
  await h.worker.handle(request(6)); assert.deepEqual(h.posted.map((m) => m.stage), ['detail']);
  validGlb(h.posted[0].result.buffer); assert.equal(h.builds.length, 1);
});

test('kit-wait cancellation and queued cancellation preserve fresh jobs with no overlapping stages', async () => {
  const kitGate = deferred(), h = harness({ loadAssets: () => kitGate.promise });
  const a = h.worker.handle(request(10, true)), b = h.worker.handle(request(11)), c = h.worker.handle(request(12));
  await h.worker.handle({ id: 11, cancel: true }); const d = h.worker.handle(request(13));
  await h.worker.handle({ id: 10, cancel: true }); kitGate.resolve(await assets);
  await Promise.all([a,b,c,d]);
  assert.deepEqual(h.posted.map((m) => [m.id, m.stage]), [[12,'detail'],[12,'complete'],[13,'detail'],[13,'complete']]);
  assert.equal(h.plans.length, 2);
});

test('queue pressure is bounded and explicitly supersedes oldest pending requests instead of starving fresh scenes', async () => {
  const gate = deferred(), h = harness({ loadAssets: () => gate.promise }), all = [];
  for (let id = 20; id <= 24; id++) all.push(h.worker.handle(request(id)));
  await h.worker.handle({ id: 20, cancel: true }); gate.resolve(await assets); await Promise.all(all);
  assert.deepEqual(h.posted.filter((m) => m.error).map((m) => m.id), [21,22]);
  assert.ok(h.posted.filter((m) => m.error).every((m) => /superseded/.test(m.error)));
  assert.deepEqual(h.posted.filter((m) => m.stage).map((m) => [m.id, m.stage]), [[23,'detail'],[23,'complete'],[24,'detail'],[24,'complete']]);
  assert.equal(h.plans.length, 2);
});

test('an optional overview failure completes successfully with the valid detailed scene and an explicit error', async () => {
  const h = harness({ build: (...args) => { if (args[3].detail === 'overview') throw new Error('overview allocation failed'); return buildNeighborhoodGlb(...args); } });
  await h.worker.handle(request(30)); assert.deepEqual(h.posted.map((m) => m.stage), ['detail','complete']);
  validGlb(h.posted[0].result.buffer); const complete = h.posted[1]; assert.equal(complete.error, undefined);
  assert.equal(complete.result.overviewBuffer, null); assert.equal(complete.result.overviewError, 'overview allocation failed'); assert.equal(complete.result.compileStats.planningPasses, 1);
});

test('asset errors are reported and a subsequent job retries rather than caching a rejected kit promise', async () => {
  let loads = 0; const h = harness({ loadAssets: async () => { if (++loads === 1) throw new Error('assets unavailable'); return assets; } });
  await h.worker.handle(request(40)); assert.deepEqual(h.posted, [{ id: 40, error: 'assets unavailable' }]);
  await h.worker.handle(request(41)); assert.equal(loads, 2); assert.deepEqual(h.posted.slice(1).map((m) => m.stage), ['detail','complete']);
});
