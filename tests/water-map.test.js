// Water map: worldwide yearly rainfall (MERRA-2) with wetter/drier-than-normal colouring;
// future years use the normal, scaled at each study site by the CMIP6 ensemble change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { waterPlan, siteFactor, waterColor, anomalyColor, WATER_SCALE } from '../apps/web/js/water-map.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const sites = json('../data/cloudshadow/sites.json').sites;

test('worldwide grids exist for every observed year plus the normal', () => {
  const ix = json('../data/cloudshadow/watermaps/global/index.json');
  assert.equal(ix.years[0], 2003); assert.equal(ix.years.at(-1), 2025);
  for (const y of ix.years) assert.ok(existsSync(new URL(`../data/cloudshadow/watermaps/global/${y}.png`, import.meta.url)), String(y));
  assert.ok(existsSync(new URL('../data/cloudshadow/watermaps/global/normal.png', import.meta.url)));
  assert.equal(ix.grid.nx * ix.grid.ny, 576 * 361);
});

test('every study site has CMIP6 rainfall factors to 2100 for three pathways', () => {
  for (const s of sites) {
    const doc = json(`../data/cloudshadow/watermaps/${s.id}.json`);
    for (const scen of ['ssp126', 'ssp245', 'ssp370']) assert.ok(doc.projection.scenarios[scen].byYear['2100'] > 0.5, `${s.id} ${scen}`);
  }
});

test('years map to observed grids; future years use the normal scaled at the study site', () => {
  const ix = { years: Array.from({ length: 23 }, (_, i) => 2003 + i) };
  assert.deepEqual(waterPlan(ix, 2015), { kind: 'observed', file: '2015.png', year: 2015 });
  assert.equal(waterPlan(ix, 2026).file, '2025.png');
  assert.equal(waterPlan(ix, 2001).file, '2003.png');
  assert.equal(waterPlan(ix, 2050).kind, 'projected');
  const doc = json('../data/cloudshadow/watermaps/colossus1.json');
  assert.equal(siteFactor(doc, 2050, 'ssp370').factor, doc.projection.scenarios.ssp370.byYear['2050']);
  assert.equal(siteFactor(doc, 2026), null, 'no projection for the present year');
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
