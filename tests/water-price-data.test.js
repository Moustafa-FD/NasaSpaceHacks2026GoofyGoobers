import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadWaterPriceData, waterPriceSnapshot } from '../apps/web/js/water-price-data.js';

const data = JSON.parse(readFileSync(new URL('../data/cloudshadow/water-prices/index.json', import.meta.url), 'utf8'));
const ids = { west: 'census-0574540', horn: 'census-2833700', ashburn: 'census-5103320', impact: 'census-4835816', dallesport: 'census-5316550' };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('all five nearest mapped cities have researched entries with a tariff or an explicit evidence gap', () => {
  for (const id of Object.values(ids)) {
    assert.ok(data.cities[id], id);
    const s = waterPriceSnapshot(data, id, 2026);
    if (s.kind === 'unavailable') { assert.equal(s.monthlyBillUsd, null); assert.ok(s.reason.length > 20); }
    else { assert.ok(s.monthlyBillUsd > 0); assert.match(s.sourceUrl, /^https:\/\//); }
  }
});

test('West Memphis uses water per-hundred-gallon conversion, with no repeated net discount or invented tariff date', () => {
  const s = waterPriceSnapshot(data, ids.west, 2026);
  near(s.monthlyBillUsd, 13 + 30 * .0969);
  assert.equal(s.kind, 'reference');
  assert.equal(s.rateYear, null); assert.equal(s.effectiveDate, null);
  assert.match(s.referenceNote, /date unspecified/);
  near(waterPriceSnapshot(data, ids.west, 2026, 7700).monthlyBillUsd, 13 + 67 * .0969 + 10 * .1164);
});

test('Horn Lake municipal minimum includes 4500 gallons and rounds additional 750-gallon increments up', () => {
  near(waterPriceSnapshot(data, ids.horn, 2024, 3000).monthlyBillUsd, 14.44);
  near(waterPriceSnapshot(data, ids.horn, 2024, 4500).monthlyBillUsd, 14.44);
  near(waterPriceSnapshot(data, ids.horn, 2024, 4501).monthlyBillUsd, 14.44 + 4.01);
  near(waterPriceSnapshot(data, ids.horn, 2024, 6000).monthlyBillUsd, 14.44 + 8.02);
  const s = waterPriceSnapshot(data, ids.horn, 2026);
  assert.equal(s.kind, 'reference'); assert.equal(s.rateYear, 2024);
  assert.equal(s.adoptionDate, '2024-11-05'); assert.equal(s.effectiveDate, null);
  assert.equal(s.includedGallons, 4500); assert.equal(s.incrementGallons, 750); assert.equal(s.incrementChargeUsd, 4.01);
  assert.match(s.provider, /municipal/); assert.doesNotMatch(s.provider, /Association/);
});

test('Loudoun water calculates quarterly tiers at quarterly use, then normalizes the entire bill by three', () => {
  const s = waterPriceSnapshot(data, { id: ids.ashburn }, 2026, 3000);
  near(s.monthlyBillUsd, (45.97 + 9 * 3.37) / 3);
  near(s.fixedChargeUsd, 45.97 / 3);
  assert.equal(s.kind, 'reported'); assert.equal(s.billingMonths, 3);
  // 30,000 gallons in a quarter crosses the 25,000-gallon first tier.
  near(waterPriceSnapshot(data, ids.ashburn, 2026, 10000).monthlyBillUsd, (45.97 + 25 * 3.37 + 5 * 9.34) / 3);
  // 60,000 gallons in a quarter also crosses the 50,000-gallon tier.
  near(waterPriceSnapshot(data, ids.ashburn, 2026, 20000).monthlyBillUsd, (45.97 + 25 * 3.37 + 25 * 9.34 + 10 * 12.52) / 3);
});

test('Loudoun published 2025 and approved scheduled 2027 prices are not statistical forecasts', () => {
  near(waterPriceSnapshot(data, ids.ashburn, 2025).monthlyBillUsd, 23.77);
  const scheduled = waterPriceSnapshot(data, ids.ashburn, 2027);
  near(scheduled.monthlyBillUsd, (49.19 + 9 * 3.61) / 3);
  assert.equal(scheduled.kind, 'reported'); assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.forecastAvailable, false);
  assert.match(scheduled.referenceNote, /Approved scheduled/);
});

test('Dallesport uses residential district water, never the industrial or wastewater schedule', () => {
  const s = waterPriceSnapshot(data, ids.dallesport, 2026);
  assert.equal(s.provider, 'Dallesport Water District');
  near(s.monthlyBillUsd, 69.54);
  near(waterPriceSnapshot(data, ids.dallesport, 2026, 15000).monthlyBillUsd, 65.64 + 10 * 1.30 + 5 * 1.45);
  assert.equal(s.scope, 'water only');
  assert.match(s.exampleLabel, /not an average household bill/);
  assert.match(s.exclusions, /excludes sewer/);
});

test('unrecorded historical and future years keep references visibly separate from actual year prices', () => {
  for (const year of [2005, 2030, 2100]) {
    const s = waterPriceSnapshot(data, ids.dallesport, year);
    assert.equal(s.kind, 'reference'); assert.equal(s.year, year); assert.equal(s.rateYear, 2026);
    assert.equal(s.forecastAvailable, false); assert.equal(s.changePct, null);
    assert.match(s.referenceNote, /not the price for/); assert.match(s.referenceNote, /not a forecast/);
  }
});

test('unknown supplier, city, or invalid consumption never creates a zero price', () => {
  for (const s of [waterPriceSnapshot(data, ids.impact, 2026), waterPriceSnapshot(data, 'unknown', 2026),
    waterPriceSnapshot(data, ids.west, 2026, -1), waterPriceSnapshot(data, ids.west, 2026, NaN)]) {
    assert.equal(s.kind, 'unavailable'); assert.equal(s.monthlyBillUsd, null);
    assert.equal(s.forecastAvailable, false);
  }
  assert.match(waterPriceSnapshot(data, ids.impact, 2026).reason, /not verified/);
});

test('water evidence uses a single cached request and retries failed acquisition', async () => {
  let requests = 0;
  const fetchImpl = async url => { requests++; assert.equal(url, 'data/water-prices/index.json'); return { ok: requests > 1, json: async () => data }; };
  await assert.rejects(loadWaterPriceData({ fetchImpl }), /unavailable/);
  const [a, b] = await Promise.all([loadWaterPriceData({ fetchImpl }), loadWaterPriceData({ fetchImpl })]);
  assert.equal(a, b); assert.equal(requests, 2);
});
