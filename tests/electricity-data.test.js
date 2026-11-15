import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { electricitySnapshot, fitElectricityTrend, validateElectricityTrend, nearbyElectricityCities, nearestElectricityCity, loadElectricityData } from '../apps/web/js/electricity-data.js';

const data = JSON.parse(readFileSync(new URL('../data/cloudshadow/electricity/index.json', import.meta.url), 'utf8'));
const sites = JSON.parse(readFileSync(new URL('../data/cloudshadow/sites.json', import.meta.url), 'utf8')).sites;
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test('EIA extraction covers all states and preserves official row totals and units', () => {
  assert.equal(Object.keys(data.states).length, 51);
  assert.equal(data.coverage.firstObservedYear, 1990);
  assert.equal(data.coverage.lastObservedYear, 2025);
  for (const entry of Object.values(data.states)) {
    assert.equal(entry.records.length, 36);
    for (const [i, r] of entry.records.entries()) {
      assert.equal(r.year, 1990 + i);
      assert.ok(r.customers > 0);
      near(r.monthlyBillUsd, r.revenueThousandUsd * 1000 / r.customers / 12, .000051);
      near(r.monthlyKwh, r.salesMwh * 1000 / r.customers / 12, .000051);
      // EIA's rounded cents/kWh = thousand USD / MWh × 100. Seven 1997–1998
      // published rows differ more; retain and explicitly flag those source values.
      if (r.year >= 2000) near(r.priceCentsKwh, r.revenueThousandUsd / r.salesMwh * 100, .0051);
      else if (Math.abs(r.priceCentsKwh - r.revenueThousandUsd / r.salesMwh * 100) > .006)
        assert.ok(r.qualityFlags.includes('published-price-differs-from-revenue-sales-ratio'));
    }
  }
  for (const source of data.sources) {
    assert.match(source.url, /^https:\/\/(www\.eia\.gov|www2\.census\.gov)\//);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.match(source.retrievedAt, /^2026-/);
  }
});

test('each site has nearby sourced places and a genuinely pre-onset baseline', () => {
  for (const site of sites) {
    const cities = nearbyElectricityCities(data, site);
    assert.ok(cities.length >= 6, site.id);
    assert.ok(cities.every(c => c.distanceKm <= 80 && c.sourceId === 'census-gazetteer-2020'));
    const onset = Number(site.onset.slice(0, 4));
    const snapshot = electricitySnapshot(data, cities[0], 2025, onset);
    assert.equal(snapshot.baselineYear, onset - 1);
    assert.equal(snapshot.kind, 'observed');
    assert.ok(snapshot.baselineBillUsd > 0);
    assert.equal(electricitySnapshot(data, cities[0], onset - 1, onset).facilityPhase, 'before');
    assert.equal(electricitySnapshot(data, cities[0], onset, onset).facilityPhase, 'after');
  }
  assert.equal(electricitySnapshot(data, 'OR', 2025, 2006).baselineYear, 2005);
  assert.equal(electricitySnapshot(data, 'VA', 2025, 2012).baselineYear, 2011);
});

test('one nearest mapped city is chosen by geodesic distance, never a manual primary-city priority', () => {
  // Independently rank central angles with the spherical law of cosines, rather
  // than reusing the production haversine helper or a curated-list order.
  const radians = degrees => degrees * Math.PI / 180;
  const centralAngle = (a, b) => Math.acos(Math.min(1, Math.max(-1,
    Math.sin(radians(a.lat)) * Math.sin(radians(b.lat)) +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(radians(a.lon - b.lon)))));
  for (const site of sites) {
    const allowed = data.sites[site.id].cityIds;
    const ranked = data.cities.filter(c => allowed.includes(c.id)).sort((a, b) => centralAngle(site, a) - centralAngle(site, b));
    assert.equal(nearestElectricityCity(data, site).id, ranked[0].id, site.id);
    assert.equal(nearestElectricityCity(data, site).id, nearbyElectricityCities(data, site, 1)[0].id);
  }
  const abilene = sites.find(s => s.id === 'abilene');
  assert.equal(nearestElectricityCity(data, abilene).name, 'Impact', 'closer Impact wins over first-listed Abilene');
});

test('nearest mapped city has the shared 80 km bound and stays absent without approved evidence', () => {
  const site = { id: 'test', lat: 35, lon: -90 };
  const fixture = { sites: { test: { cityIds: ['far', 'near'] } }, states: { TN: { records: [{ year: 2025, priceCentsKwh: 13 }] } },
    cities: [{ id: 'far', name: 'Far', state: 'TN', lat: 35.8, lon: -90 }, { id: 'near', name: 'Near', state: 'TN', lat: 35.7, lon: -90 }] };
  assert.equal(nearestElectricityCity(fixture, site).id, 'near');
  assert.ok(nearestElectricityCity(fixture, site).distanceKm < 80);
  assert.equal(nearestElectricityCity({ ...fixture, cities: fixture.cities.slice(0, 1) }, site), null);
  assert.equal(nearestElectricityCity(fixture, { ...site, lat: NaN }), null);
  assert.equal(nearestElectricityCity(fixture, { ...site, id: 'unapproved' }), null);
  assert.equal(nearestElectricityCity({ ...fixture, states: {} }, site), null);
  assert.equal(nearestElectricityCity({ ...fixture, states: { TN: { records: [] } } }, site), null);
  assert.equal(nearestElectricityCity(null, site), null);
});

test('monthly average bills and constant-use price comparisons remain distinct', () => {
  const s = electricitySnapshot(data, 'TN', 2025, 2024);
  const latest = data.states.TN.records.at(-1), baseline = data.states.TN.records.find(r => r.year === 2023);
  near(s.monthlyBillUsd, latest.monthlyBillUsd);
  near(s.baselineBillUsd, baseline.monthlyBillUsd);
  near(s.baselineComparableBillUsd, baseline.priceCentsKwh * latest.monthlyKwh / 100);
  near(s.monthlyComparableBillUsd, latest.priceCentsKwh * latest.monthlyKwh / 100);
  near(s.comparableBillChangeUsd, (latest.priceCentsKwh - baseline.priceCentsKwh) * latest.monthlyKwh / 100);
  assert.notEqual(s.billChangeUsd, s.comparableBillChangeUsd);
  assert.match(s.attribution, /no data-center share/);
});

test('timeline interpolation is continuous, preserves decreases and never bridges gaps', () => {
  const a = electricitySnapshot(data, 'TN', 2023, 2024), b = electricitySnapshot(data, 'TN', 2024, 2024);
  const halfway = electricitySnapshot(data, 'TN', 2023.5, 2024);
  near(halfway.priceCentsKwh, (a.priceCentsKwh + b.priceCentsKwh) / 2);
  assert.equal(halfway.interpolated, true);
  const decreasing = data.states.TN.records.find((r, i, rows) => i && r.priceCentsKwh < rows[i - 1].priceCentsKwh);
  assert.ok(decreasing);
  const lower = electricitySnapshot(data, 'TN', decreasing.year, decreasing.year);
  assert.ok(lower.changePct < 0, 'observed declines are retained');
  const fixture = structuredClone(data);
  fixture.states.TN.records = fixture.states.TN.records.filter(r => r.year !== 2020);
  assert.equal(electricitySnapshot(fixture, 'TN', 2020.5, 2024).kind, 'unavailable');
});

test('future trend starts at latest observation, uses constant kWh and widens uncertainty', () => {
  const now = electricitySnapshot(data, 'OR', 2025, 2006), soon = electricitySnapshot(data, 'OR', 2025.000001, 2006);
  near(now.priceCentsKwh, soon.priceCentsKwh, .0001);
  const s1 = electricitySnapshot(data, 'OR', 2026, 2006), s10 = electricitySnapshot(data, 'OR', 2035, 2006);
  assert.equal(s1.kind, 'projected');
  assert.equal(s1.billBasis, 'fixed-2025-usage');
  near(s1.monthlyBillUsd, s1.priceCentsKwh * now.monthlyKwh / 100);
  assert.ok(s1.lowerPriceCentsKwh < s1.priceCentsKwh && s1.upperPriceCentsKwh > s1.priceCentsKwh);
  assert.ok(s10.upperPriceCentsKwh / s10.lowerPriceCentsKwh > s1.upperPriceCentsKwh / s1.lowerPriceCentsKwh);
  assert.equal(s1.validationCount, 5);
  assert.equal(s1.validationHorizonYears, 1);
});

test('long horizons, missing states and absent pre-onset records are not backfilled', () => {
  for (const s of [electricitySnapshot(data, 'TN', 2036, 2024), electricitySnapshot(data, 'TN', 1989, 2024), electricitySnapshot(data, 'XX', 2030, 2024)]) {
    assert.equal(s.kind, 'unavailable');
    assert.equal(s.priceCentsKwh, null);
    assert.equal(s.monthlyBillUsd, null);
    assert.equal(s.changePct, null);
  }
  const missingBaseline = electricitySnapshot(data, 'OR', 2025, 1980);
  assert.equal(missingBaseline.kind, 'observed');
  assert.equal(missingBaseline.baselineYear, null);
  assert.equal(missingBaseline.changePct, null);
});

test('state proxies do not invent municipality variation or a distance-decay price', () => {
  const memphis = data.cities.find(c => c.name === 'Memphis'), bartlett = data.cities.find(c => c.name === 'Bartlett');
  const a = electricitySnapshot(data, memphis, 2030, 2024), b = electricitySnapshot(data, bartlett, 2030, 2024);
  near(a.priceCentsKwh, b.priceCentsKwh);
  near(a.changePct, b.changePct);
  assert.match(a.geographyLabel, /state average · city proxy/);
});

test('trend regression supports falling prices and independently predictable exponential series', () => {
  const records = Array.from({ length: 15 }, (_, i) => ({ year: 2000 + i, priceCentsKwh: 10 * Math.exp(-.02 * i) }));
  const model = fitElectricityTrend(records);
  near(model.slope, -.02);
  const validation = validateElectricityTrend(records);
  near(validation.validationMaePct, 0, 1e-10);
  assert.ok(validation.naiveMaePct > 1);
  assert.equal(fitElectricityTrend(records.slice(0, 3)), null);
});

test('UI and 3D share one evidence request, with retry after a load failure', async () => {
  let count = 0;
  const fetchImpl = async (url) => { count++; assert.equal(url, 'data/electricity/index.json'); return { ok: true, json: async () => data }; };
  const [a, b] = await Promise.all([loadElectricityData({ fetchImpl }), loadElectricityData({ fetchImpl })]);
  assert.equal(a, b); assert.equal(count, 1);
  let attempts = 0;
  const flaky = async () => ({ ok: ++attempts > 1, json: async () => data });
  await assert.rejects(loadElectricityData({ fetchImpl: flaky }), /unavailable/);
  assert.equal(await loadElectricityData({ fetchImpl: flaky }), data);
  assert.equal(attempts, 2);
});
