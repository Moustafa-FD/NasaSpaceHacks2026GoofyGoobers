// Water map: worldwide yearly rainfall (MERRA-2) with wetter/drier-than-normal colouring;
// 2027–2035 continue each cell's significant measured trend; no water map after 2035.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { waterPlan, projectedRain, waterColor, anomalyColor, WATER_SCALE } from '../apps/web/js/water-map.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('worldwide grids exist for every observed year plus the normal', () => {
  const ix = json('../data/cloudshadow/watermaps/global/index.json');
  assert.equal(ix.years[0], 2003); assert.equal(ix.years.at(-1), 2025);
  for (const y of ix.years) assert.ok(existsSync(new URL(`../data/cloudshadow/watermaps/global/${y}.png`, import.meta.url)), String(y));
  assert.ok(existsSync(new URL('../data/cloudshadow/watermaps/global/normal.png', import.meta.url)));
  assert.equal(ix.grid.nx * ix.grid.ny, 576 * 361);
});

test('years: observed 2003–2025, trend projection 2027–2035, nothing after 2035', () => {
  const ix = { years: Array.from({ length: 23 }, (_, i) => 2003 + i), trend: { projectionThrough: 2035 } };
  assert.deepEqual(waterPlan(ix, 2015), { kind: 'observed', file: '2015.png', year: 2015 });
  assert.equal(waterPlan(ix, 2025).file, '2025.png');
  assert.equal(waterPlan(ix, 2026).file, '2025.png');
  assert.equal(waterPlan(ix, 2001).file, '2003.png');
  assert.equal(waterPlan(ix, 2030).kind, 'projected');
  assert.equal(waterPlan(ix, 2036).kind, 'none');
  assert.equal(waterPlan(ix, 2080).kind, 'none');
});

test('projected rainfall follows the cell trend line only where it is significant', () => {
  assert.equal(projectedRain(1000, 10, 2034.5, 2014.5), 1200);
  assert.equal(projectedRain(1000, 0, 2030), null, 'no significant trend = no projection');
  assert.equal(projectedRain(100, -20, 2035, 2014.5), 0, 'never below zero');
  const ix = json('../data/cloudshadow/watermaps/global/index.json');
  assert.equal(ix.trend.projectionThrough, 2035);
  assert.ok(existsSync(new URL('../data/cloudshadow/watermaps/global/trend.png', import.meta.url)));
});

test('colour scales: absolute brown→teal; change from normal brown (drier) → teal (wetter)', () => {
  assert.deepEqual(waterColor(0).slice(0, 3), [140, 81, 10]);
  assert.deepEqual(waterColor(WATER_SCALE.max).slice(0, 3), [1, 102, 94]);
  assert.equal(waterColor(null)[3], 0);
  assert.deepEqual(anomalyColor(-50).slice(0, 3), [140, 81, 10]);
  assert.deepEqual(anomalyColor(50).slice(0, 3), [1, 102, 94]);
  assert.ok(anomalyColor(0)[3] < anomalyColor(20)[3], 'normal years are faint, big departures strong');
});

test('both UIs map every measured theme, with a projected 2035 side and rainfall for water', () => {
  const ui = readFileSync(new URL('../apps/web/js/ui-shell.js', import.meta.url), 'utf8');
  assert.match(ui, /data-side="future"/);
  assert.match(ui, /FUTURE_YEAR = 2035/);
  assert.match(ui, /MAP_LAYER = \{ heat: "LST_Night", green: "NDVI", air: "NO2_OMI", water: "Water" \}/);
  assert.match(readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8'), /data-map-layer="Water"/);
});
