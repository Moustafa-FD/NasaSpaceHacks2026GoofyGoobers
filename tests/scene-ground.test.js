import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneGround } from '../apps/web/js/fluid-gpu.js';

function setup(t, neighborhood) {
  const oldCesium = globalThis.Cesium, oldNeighborhood = globalThis.CloudShadowNeighborhood;
  globalThis.Cesium = { Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) } };
  if (neighborhood) globalThis.CloudShadowNeighborhood = neighborhood;
  else delete globalThis.CloudShadowNeighborhood;
  t.after(() => {
    if (oldCesium === undefined) delete globalThis.Cesium; else globalThis.Cesium = oldCesium;
    if (oldNeighborhood === undefined) delete globalThis.CloudShadowNeighborhood; else globalThis.CloudShadowNeighborhood = oldNeighborhood;
  });
}

test('scene ground prefers loaded neighborhood terrain without rendering a height pick or sampling a roof', (t) => {
  let reads = 0;
  setup(t, { groundHeightAt(lon, lat) { assert(Number.isFinite(lon) && Number.isFinite(lat)); return [105, 101, 99, 103, 104][reads++]; } });
  const viewer = { scene: {
    sampleHeightSupported: true,
    sampleHeight() { throw new Error('Nested picking must never run during a frame.'); },
    globe: { getHeight() { throw new Error('Loaded neighborhood DEM takes priority over ellipsoid ground.'); } },
  } };
  assert.equal(sceneGround(viewer, 35, -90), 99);
  assert.equal(reads, 5);
});

test('scene ground uses already loaded globe heights when neighborhood terrain is absent', (t) => {
  setup(t, { groundHeightAt() { return null; } });
  const points = [], values = [undefined, 27, 24, NaN, 26];
  const viewer = { scene: {
    sampleHeightSupported: true,
    sampleHeight() { throw new Error('Height picking is not a terrain-data fallback.'); },
    globe: { getHeight(point) { points.push(point); return values[points.length - 1]; } },
  } };
  assert.equal(sceneGround(viewer, 35, -90), 24);
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], { lon: -90, lat: 35 });
  assert(points[1].lon > -90 && points[2].lon < -90);
  assert(points[3].lat > 35 && points[4].lat < 35);
});

test('unloaded ground stays unknown and a valid zero elevation is preserved', (t) => {
  setup(t);
  assert.equal(sceneGround({ scene: { globe: { getHeight() { return undefined; } } } }, 35, -90), null);
  assert.equal(sceneGround({ scene: { globe: { getHeight() { return 0; } } } }, 35, -90), 0);
  assert.equal(sceneGround(null, 35, -90), null);
  assert.equal(sceneGround({ scene: {} }, NaN, -90), null);
});
