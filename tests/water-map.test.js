// Water map: rainfall mm/year on one scale; observed past years, CMIP6-scaled future years.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waterYear, waterColor, siteValue, WATER_SCALE } from '../apps/web/js/water-map.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const sites = json('../data/cloudshadow/sites.json').sites;

test('every site has observed 2003–2025 rainfall maps and CMIP6 factors to 2100', () => {
  for (const s of sites) {
    const doc = json(`../data/cloudshadow/watermaps/${s.id}.json`);
    assert.equal(doc.schemaVersion, 'water-map/1.0');
    assert.deepEqual([Object.keys(doc.observed)[0], Object.keys(doc.observed).at(-1)], ['2003', '2025']);
    const n = doc.grid.nx * doc.grid.ny;
    assert.equal(doc.normal.length, n);
    for (const scen of ['ssp126', 'ssp245', 'ssp370']) assert.ok(doc.projection.scenarios[scen].byYear['2100'] > 0.5, `${s.id} ${scen}`);
  }
});

test('site rainfall is realistic and ordered wet to dry across sites', () => {
  const normal = (id) => { const d = json(`../data/cloudshadow/watermaps/${id}.json`); return siteValue(d, d.normal); };
  assert.ok(normal('colossus1') > 1000 && normal('colossus1') < 1600);
  assert.ok(normal('abilene') < normal('ashburn') && normal('ashburn') < normal('colossus1'));
});

test('observed years show their own map; future years scale the 2005–2024 normal', () => {
  const doc = json('../data/cloudshadow/watermaps/colossus1.json');
  assert.equal(waterYear(doc, 2015).kind, 'observed');
  assert.deepEqual(waterYear(doc, 2015).values, doc.observed['2015']);
  const f = waterYear(doc, 2050, 'ssp370');
  assert.equal(f.kind, 'projected');
  assert.equal(siteValue(doc, f.values), Math.round(siteValue(doc, doc.normal) * doc.projection.scenarios.ssp370.byYear['2050']));
  assert.equal(waterYear(doc, 2026).year, 2025, 'incomplete year falls back to the latest complete year');
});

test('one colour scale: dry is brown, wet is teal, missing is transparent', () => {
  assert.deepEqual(waterColor(0).slice(0, 3), [140, 81, 10]);
  assert.deepEqual(waterColor(WATER_SCALE.max).slice(0, 3), [1, 102, 94]);
  assert.equal(waterColor(null)[3], 0);
});

test('new UI offers a projected 2035 side and the water theme shows the rainfall map', () => {
  const ui = readFileSync(new URL('../apps/web/js/ui-shell.js', import.meta.url), 'utf8');
  assert.match(ui, /data-side="future"/);
  assert.match(ui, /FUTURE_YEAR = 2035/);
  assert.match(ui, /S\.theme === "water" \? "Water"/);
  assert.match(readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8'), /data-map-layer="Water"/);
});
