// Issue #11: consistent panel/map defaults, no blank "Unknown" headline values,
// vegetation future views with sourced content, and prepared water context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveStoryVariables, summarizeStoryMetric } from '../apps/web/js/environment-story-data.js';
import { effectiveStoryMode, storyMetricHtml, storyGiovanniWaterHtml, vegetationDriversHtml, storyFutureHtml } from '../apps/web/js/environment-story.js';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sites = json('../data/cloudshadow/sites.json').sites;
const varsFor = (id) => { const raw = json(`../data/cloudshadow/series/${id}.json`); return raw.vars || raw; };
const headline = (html) => [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map((m) => m[1]);

test('app starts on the same NO₂ dataset as the "Air pollution" map button', () => {
  const app = readFileSync(new URL('../apps/web/js/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(app, /varId: "NO2_OMI"/);
  assert.match(html, /data-map-layer="NO2_OMI"[^>]*>.*Air pollution/);
  for (const site of sites) assert.equal(resolveStoryVariables(varsFor(site.id), 'LST_Day').air, 'NO2_OMI');
});

test('default Air, Vegetation and Heat views show numbers for 2025 at every site', () => {
  for (const site of sites) {
    for (const variable of ['NO2_OMI', 'NDVI', 'LST_Day']) {
      const summary = summarizeStoryMetric(varsFor(site.id)[variable], site, variable, 2025, null);
      const { mode } = effectiveStoryMode(summary, 'trend');
      const values = headline(storyMetricHtml(summary, mode));
      assert.ok(values.length >= 2, `${site.id} ${variable}`);
      assert.ok(values.slice(0, 2).every((v) => v !== 'Unknown'), `${site.id} ${variable}: ${values}`);
    }
  }
});

test('short TROPOMI record falls back to one year with a reason instead of "Unknown"', () => {
  const site = sites.find((s) => s.id === 'colossus1');
  const summary = summarizeStoryMetric(varsFor('colossus1').NO2, site, 'NO2', 2025, null);
  const { mode, fallback } = effectiveStoryMode(summary, 'trend');
  assert.equal(mode, 'year');
  assert.match(fallback, /2023/);
  assert.ok(!headline(storyMetricHtml(summary, mode)).slice(0, 2).includes('Unknown'));
});

test('sparse site retrievals (Colossus 1 aerosol) explain the gap and offer the latest usable year', () => {
  const site = sites.find((s) => s.id === 'colossus1');
  const summary = summarizeStoryMetric(varsFor('colossus1').AOD, site, 'AOD', 2025, null);
  const html = storyMetricHtml(summary, effectiveStoryMode(summary, 'trend').mode);
  assert.match(html, /No usable Aerosol optical depth values/);
  assert.match(html, /site months/);
  assert.doesNotMatch(html, /<strong>Unknown<\/strong>/);
});

test('vegetation future years show sourced climate drivers, never an empty view', () => {
  const raw = json('../data/cloudshadow/projections/ashburn.json');
  for (const year of [2030, 2050, 2090]) {
    const html = vegetationDriversHtml({ year, scenario: 'ssp245', products: { 'climate-projection': raw } });
    assert.match(html, /Growing conditions/);
    assert.match(html, /Annual rainfall/);
    assert.match(html, /not a vegetation or crop-yield prediction/);
    if (year > 2035) assert.match(html, /stops at 2035/);
  }
  assert.match(storyFutureHtml('vegetation', { year: 2090, scenario: 'ssp585', products: { 'climate-projection': raw } }, 'NDVI'), /Growing conditions/);
});

test('water tab shows prepared Giovanni context with honest trend verdicts', () => {
  for (const site of sites) {
    const product = json(`../data/cloudshadow/water/${site.id}.json`);
    assert.equal(product.schemaVersion, 'water-evidence/1.0');
    const html = storyGiovanniWaterHtml(product, 2025);
    for (const label of ['Groundwater storage', 'Topsoil moisture', 'Rainfall', 'Evapotranspiration']) assert.match(html, new RegExp(label));
    for (const v of Object.values(product.variables)) if (v.trend?.status === 'ok') assert.ok(['significant', 'borderline', 'not significant'].includes(v.trend.verdict));
  }
  assert.match(storyGiovanniWaterHtml(json('../data/cloudshadow/water/ashburn.json'), 2025), /Borderline trend: -19\.28 mm per decade/);
});
