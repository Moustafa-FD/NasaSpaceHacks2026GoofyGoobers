import { buildNeighborhoodGlb, planNeighborhood } from './neighborhood-core.js';
import { buildTrafficGraph } from './traffic-routes.js';
async function loadKit() {
  const [a, b] = await Promise.all([fetch('../assets/low-poly/manifest.json'), fetch('../assets/low-poly/kit.glb')]);
  if (!a.ok || !b.ok) throw new Error('Low-poly asset kit unavailable');
  return { manifest: await a.json(), kit: await b.arrayBuffer() };
}
const errorText = (error) => error?.message || String(error);
const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One active build and two queued requests bound memory during rapid navigation.
 * Dependencies are injectable to exercise cancellation with the real GLB builder. */
export function createNeighborhoodWorker({
  postMessage, loadAssets = loadKit, plan = planNeighborhood,
  build = buildNeighborhoodGlb, graph = buildTrafficGraph,
  taskBoundary = yieldTask, now = () => performance.now(),
} = {}) {
  let kitPromise, running = false;
  const jobs = new Map(), queue = [];
  function settle(job) {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    job.resolve();
  }
  function post(job, message, transfer = []) {
    if (!job.cancelled) postMessage({ id: job.id, ...message }, transfer);
  }
  const assetCounts = (result) => ({
    unusedAssetBytesRemoved: result.assetStats?.unusedAssetBytesRemoved ?? 0,
    surfaceVerticesRemoved: (result.assetStats?.sourceSurfaceVertices ?? 0) - (result.assetStats?.packedSurfaceVertices ?? 0),
  });
  async function run(job) {
    const { snapshot, elevation, options = {}, progressive = false } = job.request;
    kitPromise ||= Promise.resolve().then(loadAssets).catch((error) => { kitPromise = null; throw error; });
    const { manifest, kit } = await kitPromise;
    if (job.cancelled) return;
    const started = now();
    let previewMs = 0;
    if (progressive) {
      const at = now();
      const preview = build(snapshot, manifest, kit, {
        ...options, elevation, preparedPlan: undefined, preview: true, detail: 'overview',
        maxInfillBuildings: 0, maxTrees: 0, maxCrops: 0, maxGrass: 0, terrainSpacingM: 150,
      });
      previewMs = now() - at;
      preview.stage = 'preview';
      preview.compileStats = { previewMs, planningPasses: 0, totalMs: now() - started };
      post(job, { stage: 'preview', result: preview }, [preview.buffer]);
      await taskBoundary();
      if (job.cancelled) return;
    }
    const planningStarted = now();
    const preparedPlan = plan(snapshot, manifest, { ...options, elevation, preview: false });
    const planningMs = now() - planningStarted, detailStarted = now();
    let detail = build(snapshot, manifest, kit, { ...options, elevation, preview: false, preparedPlan, detail: 'close' });
    // Maps and shared arc references survive structured cloning. Only the close
    // stage owns traffic state; neither preview nor overview creates a graph.
    detail.trafficGraph = graph(detail.roadPaths);
    const detailMs = now() - detailStarted, detailCounts = assetCounts(detail);
    const compileStats = { previewMs, planningPasses: 1, planningMs, detailMs, totalMs: now() - started, ...detailCounts };
    detail.stage = 'detail';
    detail.compileStats = { ...compileStats };
    post(job, { stage: 'detail', result: detail }, [detail.buffer]);
    detail = null;
    await taskBoundary();
    if (job.cancelled) return;
    const overviewStarted = now();
    try {
      const overview = build(snapshot, manifest, kit, {
        ...options, elevation, preview: false, preparedPlan, detail: 'overview',
        maxTrees: 1800, maxCrops: 0, maxGrass: 0,
      });
      const counts = assetCounts(overview);
      post(job, { stage: 'complete', result: {
        overviewBuffer: overview.buffer,
        compileStats: { ...compileStats, overviewMs: now() - overviewStarted, totalMs: now() - started,
          unusedAssetBytesRemoved: detailCounts.unusedAssetBytesRemoved + counts.unusedAssetBytesRemoved,
          surfaceVerticesRemoved: detailCounts.surfaceVerticesRemoved + counts.surfaceVerticesRemoved },
      } }, [overview.buffer]);
    } catch (error) {
      // Optional distance geometry must not discard an already usable close scene.
      post(job, { stage: 'complete', result: { overviewBuffer: null, overviewError: errorText(error),
        compileStats: { ...compileStats, overviewMs: now() - overviewStarted, totalMs: now() - started } } });
    }
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try { if (!job.cancelled) await run(job); }
        catch (error) { post(job, { error: errorText(error) }); }
        finally { settle(job); }
      }
    } finally { running = false; }
  }
  function handle(request = {}) {
    const { id } = request;
    if (!['number', 'string'].includes(typeof id) || (typeof id === 'number' && !Number.isFinite(id))) return Promise.resolve();
    if (request.cancel) {
      const job = jobs.get(id);
      if (job) {
        job.cancelled = true;
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); settle(job); }
      }
      return Promise.resolve();
    }
    if (jobs.has(id)) return jobs.get(id).done;
    if (queue.length >= 2) {
      const superseded = queue.shift();
      post(superseded, { error: 'Neighborhood generation superseded by a newer queued scene' });
      settle(superseded);
    }
    const job = { id, request, cancelled: false };
    job.done = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(id, job); queue.push(job); void pump();
    return job.done;
  }
  return { handle };
}

if (typeof self !== 'undefined') {
  const worker = createNeighborhoodWorker({ postMessage: (message, transfer) => self.postMessage(message, transfer) });
  self.onmessage = ({ data }) => worker.handle(data);
}
