import { buildNeighborhoodGlb } from './neighborhood-core.js';
let kitPromise;
async function loadKit() {
  const [a, b] = await Promise.all([fetch('../assets/low-poly/manifest.json'), fetch('../assets/low-poly/kit.glb')]);
  if (!a.ok || !b.ok) throw new Error('Low-poly asset kit unavailable');
  return { manifest: await a.json(), kit: await b.arrayBuffer() };
}
self.onmessage = async ({ data: { id, snapshot, elevation, options = {} } }) => {
  try {
    kitPromise ||= loadKit().catch((error) => { kitPromise = null; throw error; });
    const { manifest, kit } = await kitPromise;
    const result = buildNeighborhoodGlb(snapshot, manifest, kit, { ...options, elevation });
    const overview = buildNeighborhoodGlb(snapshot, manifest, kit, { ...options, elevation, detail: 'overview', maxTrees: 1800, maxCrops: 0, maxGrass: 0 });
    result.overviewBuffer = overview.buffer;
    self.postMessage({ id, result }, [result.buffer, result.overviewBuffer]);
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
