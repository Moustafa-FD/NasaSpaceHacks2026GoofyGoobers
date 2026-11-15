// Dispersion footprints are per-year (that year's GEOS-FP winds), Colossus 1 only,
// and never shown for years without analysed winds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { plumeCoversYear } from '../apps/web/js/future-data.js';
import { observedDispersionHtml, storyFutureHtml } from '../apps/web/js/environment-story.js';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sites = json('../data/cloudshadow/sites.json').sites;
const colossus = sites.find((s) => s.id === 'colossus1');

test('one footprint per year 2018–2026, each built only from that year’s winds', () => {
  const index = json('../data/cloudshadow/plumes/colossus1/index.json');
  assert.deepEqual(index.years, [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  const bearings = new Set();
  for (const year of index.years) {
    const raw = json(`../data/cloudshadow/plumes/colossus1/${year}.json`);
    assert.equal(raw.year, year);
    assert.equal(raw.frames.first.slice(0, 4), String(year));
    assert.equal(raw.frames.last.slice(0, 4), String(year));
    assert.ok(raw.frames.total >= 10 && raw.frames.total <= 12);
    bearings.add(raw.peak.bearingDeg);
  }
  assert.ok(bearings.size > 1, 'different years produce different drift patterns');
});

test('only sites with documented on-site combustion have footprints', () => {
  for (const site of sites) {
    const has = existsSync(new URL(`../data/cloudshadow/plumes/${site.id}/index.json`, import.meta.url));
    assert.equal(has, site.effects?.plume === true, site.id);
  }
});

test('footprints are shown only inside their wind record', () => {
  const yearly = json('../data/cloudshadow/plumes/colossus1/2025.json');
  assert.equal(plumeCoversYear(yearly, 2025), true);
  assert.equal(plumeCoversYear(yearly, 2024), false);
  const multi = json('../data/cloudshadow/plumes/colossus1.json');
  assert.equal(plumeCoversYear(multi, 2020), true);
  assert.equal(plumeCoversYear(multi, 2050), false);
  assert.equal(plumeCoversYear({}, 2025), false);
});

test('panel: observed years show that year’s footprint; future years and other sites explain why not', () => {
  const raw = json('../data/cloudshadow/plumes/colossus1/2025.json');
  assert.match(observedDispersionHtml({ site: colossus, year: 2025, products: { 'plume-scenario': raw } }), /2025 winds/);
  assert.equal(observedDispersionHtml({ site: colossus, year: 2024, products: { 'plume-scenario': raw } }), '');
  assert.match(observedDispersionHtml({ site: colossus, year: 2010, products: {} }), /start in 2018/);
  assert.match(storyFutureHtml('air', { site: colossus, year: 2050, products: {} }, 'NO2_OMI'), /No dispersion footprint for 2050/);
  const ashburn = sites.find((s) => s.id === 'ashburn');
  assert.match(storyFutureHtml('air', { site: ashburn, year: 2050, products: {} }, 'NO2_OMI'), /only where on-site combustion is documented/);
  assert.equal(observedDispersionHtml({ site: ashburn, year: 2025, products: { 'plume-scenario': raw } }), '');
});
