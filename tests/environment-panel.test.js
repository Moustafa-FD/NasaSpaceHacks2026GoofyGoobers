import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agricultureSummaryHtml, climateSummaryHtml, environmentLayerControlsHtml, escapeEnvironmentHtml, resultSummaryHtml, seriesChartHtml } from '../apps/web/js/environment-panel.js';

test('climate display uses actual ensemble values and distinguishes sampled 20-year windows from 30-year context', () => {
  const data = JSON.parse(readFileSync(new URL('../data/cloudshadow/projections/ashburn.json', import.meta.url)));
  const html = climateSummaryHtml(data, { scenario: 'ssp585', year: 2088 });
  assert.match(html, /Baseline · 1995–2014/); assert.match(html, /2041–2060/); assert.match(html, /2081–2100/);
  assert.match(html, /Timeline 2088/); assert.match(html, /sampled years per 20-year window/); assert.match(html, /not confidence intervals/);
  assert.match(html, /NASA NEX-GDDP-CMIP6/); assert.match(html, /degC/); assert.match(html, /18\.8/);
  assert.doesNotMatch(html, /30-year baseline/); assert.match(html, /not predictions for an individual year/);
});

test('insufficient-data reports never present a trend slope or fabricated zero', () => {
  const html = resultSummaryHtml({ evidence: 'statistical-analysis', kind: 'trend-analysis', report: { status: 'insufficient_data', reasons: ['Only two valid years'], sen: { slopePerDecade: 99 } } });
  assert.match(html, /Only two valid years/); assert.doesNotMatch(html, /Sen slope/); assert.doesNotMatch(html, /99/);
  const proper = resultSummaryHtml({ target: { unit: '°C' }, report: { status: 'ok', sen: { slopePerDecade: .2, ciPerDecade: [.1, .4] }, mannKendall: { pValue: .000000002 } } });
  assert.match(proper, /0\.2 °C per decade/); assert.match(proper, /2\.00e-9/);
});

test('series charts break at missing samples and retain genuine zero observations', () => {
  const html = seriesChartHtml({ label: 'pH', unit: 'source unit', points: [{ date: '2020-01-01', value: 0 }, { date: '2020-01-02', value: null }, { date: '2020-01-03', value: 7 }] });
  const path = html.match(/d="(M[^"]*)"/)[1]; assert.equal((path.match(/M/g) || []).length, 2); assert.doesNotMatch(path, /L/);
  assert.match(html, /2\/3 numeric samples/); assert.match(html, /Range 0 – 7 source unit/);
  assert.match(seriesChartHtml({ points: [{ date: '2020', value: null }] }), /not zero/);
});

test('source content and URLs cannot inject active markup into the inspector', () => {
  assert.equal(escapeEnvironmentHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  const html = resultSummaryHtml({ kind: '<script>bad</script>', evidence: 'ground-observation', sourceUrl: 'javascript:alert(1)', warnings: ['<img onerror=alert(1)>'] });
  assert.doesNotMatch(html, /<script>|<img|href="javascript/); assert.match(html, /&lt;script&gt;/);
});

test('water output retains source evidence and incomplete coverage with units', () => {
  const html = resultSummaryHtml({ kind: 'water-quality', evidence: 'ground-observation', complete: false, station: { id: 'USGS-01646500', name: 'Real station' }, records: [{ parameterCode: '00010', parameterName: 'Water temperature', unit: 'degC', date: '2025-01-01', valueStatus: 'numeric', value: 4 }] });
  assert.match(html, /ground-observation/); assert.match(html, /Real station/); assert.match(html, /degC/); assert.match(html, /incomplete or capped/); assert.match(html, /censored values remain/);
});

test('native weather grid offers a spatial toggle only when a source grid exists, with date and units', () => {
  assert.doesNotMatch(environmentLayerControlsHtml({ variables: [{ id: 'T2M' }] }), /weather-layer/);
  const html = environmentLayerControlsHtml({ grid: { variable: 'T2M', date: '2020-07', units: 'degC', shape: [2, 2], values: [1, null, 3, 4] } }, 'weather');
  assert.match(html, /data-env="weather-layer" checked/); assert.match(html, /Show native weather grid/);
  assert.match(html, /2020-07/); assert.match(html, /degC/); assert.match(html, /do not resolve a facility footprint/);
});

test('agriculture display uses actual per-model season comparisons with thresholds, units and missing states', () => {
  const result = { kind: 'agriculture', evidence: 'conditional-climate-screening', settings: { growingMonths: [4, 5, 6], baseTemperatureC: 10, heatThresholdC: 35, dryDayThresholdMm: 1 }, baselinePeriod: { start: '2000-01-01', end: '2004-12-31' }, futurePeriod: { start: '2035-01-01', end: '2039-12-31' }, comparisons: [{ model: 'EC_Earth3P_HR', baselineSeasons: 5, futureSeasons: 5, indicators: { meanTemperatureC: { baselineMeanPerSeason: 20, futureMeanPerSeason: 23, change: 3 }, heatThresholdDays: { baselineMeanPerSeason: 0, futureMeanPerSeason: 12, change: 12 }, dryThresholdDays: { baselineMeanPerSeason: null, futureMeanPerSeason: 20, change: null }, growingDegreeDaysCdays: { baselineMeanPerSeason: 600, futureMeanPerSeason: 720, change: 120 } } }], warnings: ['Short periods are affected by natural variability.'] };
  const html = resultSummaryHtml(result);
  assert.match(html, /EC_Earth3P_HR/); assert.match(html, /Days above 35°C/); assert.match(html, /days\/season/); assert.match(html, /°C·days\/season/);
  assert.match(html, /<td>0<\/td><td>12<\/td><td>\+12<\/td>/);
  assert.match(html, /<td>Unavailable<\/td><td>20<\/td><td>Unavailable<\/td>/);
  assert.match(html, /not crop yields/); assert.match(html, /not irrigation demand/); assert.match(html, /natural variability/);
  assert.doesNotMatch(html, /0 source records/); assert.equal(agricultureSummaryHtml({}), '');
});
