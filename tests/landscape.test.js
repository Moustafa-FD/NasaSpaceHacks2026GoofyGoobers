import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleElevation, scenarioParameters, scenarioHeightOffset, createLandscape } from '../apps/web/js/landscape.js';
import { packElevationTexture } from '../apps/web/js/landscape-shader.js';

const plane = { width: 3, height: 3, extentM: [-1, -1, 1, 1], heights: [2, 4, 6, 5, 7, 9, 8, 10, 12], status: 'ready' };

test('bilinear DEM sampling respects south-to-north rows and exact edge samples', () => {
  assert.equal(sampleElevation(plane, 0.5, -0.5), 6.5);
  assert.equal(sampleElevation(plane, -1, -1), 2);
  assert.equal(sampleElevation(plane, 1, 1), 12);
  assert.equal(sampleElevation(plane, 1.1, 0), null);
});

test('missing DEM data are unknown, not zero, while known exact samples remain usable', () => {
  const partial = { width: 2, height: 2, extentM: [-1, -1, 1, 1], heights: [5, null, null, null] };
  assert.equal(sampleElevation(partial, -1, -1), 5);
  assert.equal(sampleElevation(partial, 0, 0), null);
  assert.equal(sampleElevation(null, 0, 0), null);
  assert.equal(createLandscape({}, null).heightAt(0, 0, 2035, true), null);
});

test('historical and future year selection does not alter static reference terrain by default', () => {
  const landscape = createLandscape({}, plane);
  assert.equal(landscape.heightAt(0.5, -0.5, 2003), 6.5);
  assert.equal(landscape.heightAt(0.5, -0.5, 2035), 6.5);
});

test('illustrative terrain scenario starts at baseline, remains deterministic and tapers at patch edges', () => {
  assert.equal(scenarioHeightOffset(0, 0, 2025), 0);
  const params = scenarioParameters(2035);
  assert.equal(params.mountainHeightM, 180);
  assert.equal(params.lakeLevelOffsetM, 12);
  assert.ok(scenarioHeightOffset(params.mountainCenterX, params.mountainCenterY, 2035) > 150);
  assert.equal(scenarioHeightOffset(-3300, 700, 2035), 0);
  assert.equal(scenarioHeightOffset(4000, 0, 2035), 0);
  assert.equal(scenarioHeightOffset(300, 400, 2031), scenarioHeightOffset(300, 400, 2031));
});

test('normalized vegetation display follows input health with stable spatial variation, not invented time decay', () => {
  const landscape = createLandscape({ siteId: 'example' });
  assert.equal(landscape.healthAt(30, 50, 2003, 1), 1);
  assert.equal(landscape.healthAt(30, 50, 2035, 0), 0);
  assert.equal(landscape.healthAt(30, 50, 2035, null), null);
  assert.equal(landscape.healthAt(30, 50, 2003, 0.5), landscape.healthAt(30, 50, 2035, 0.5));
  assert.ok(landscape.healthAt(30, 50, 2035, 0.5) <= 0.5);
});

test('land-use lookup respects polygon holes and mapped water priority', () => {
  const landscape = createLandscape({ areas: [
    { kind: 'forest', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]], holes: [[[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]]] },
    { kind: 'water', polygon: [[-2, -2], [-1, -2], [-1, 2], [-2, 2]] },
  ] });
  assert.equal(landscape.groundKindAt(0, 0), 'unknown');
  assert.equal(landscape.groundKindAt(1, 1), 'forest');
  assert.equal(landscape.groundKindAt(-1.5, 0), 'water');
});

test('GPU DEM packing preserves negative heights, row order and missing masks within its stated precision', () => {
  const grid = { width: 2, height: 2, heights: [-25, 0, 478, null] };
  const texture = packElevationTexture(grid);
  const decode = (index) => texture.min + (texture.data[index * 4] * 256 + texture.data[index * 4 + 1]) / 65535 * texture.span;
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(decode(index) - grid.heights[index]) <= texture.maxQuantizationErrorM);
    assert.equal(texture.data[index * 4 + 2], 255);
  }
  assert.equal(texture.data[14], 0);
  assert.equal(texture.width, 2);
  assert.equal(texture.height, 2);
});
