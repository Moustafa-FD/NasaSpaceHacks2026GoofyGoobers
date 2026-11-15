import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDateForYear, mapRequestKey } from '../apps/web/js/map-source-window.js';

test('selected years without observations never borrow the last available map', () => {
  const dates=['2023-09-01','2024-07-12','2024-07-20','2025-07-15'];
  assert.equal(sourceDateForYear(dates,2036),null);
  assert.equal(sourceDateForYear(dates,2022),null);
  assert.equal(sourceDateForYear(dates,2024),'2024-07-12');
  assert.equal(sourceDateForYear(dates,2023),'2023-09-01');
  assert.equal(sourceDateForYear([],2024),null);
});

test('different sites, dates and comparison modes cannot reuse the same resource', () => {
  const payload={kind:'NDVI',center:{id:'a',lat:35,lon:-90},a:{layer:'source',date:'2024-07-15'},baseline:{date:'2005-07-15'},change:true};
  const key=mapRequestKey(payload);
  for(const replacement of [{center:{id:'b',lat:35,lon:-90}},{center:{id:'a',lat:36,lon:-90}},{a:{layer:'source',date:'2025-07-15'}},{change:false},{compare:true},{baseline:{date:'2010-07-15'}}])assert.notEqual(mapRequestKey({...payload,...replacement}),key);
  assert.equal(mapRequestKey({...payload}),key);
});

test('years past the record borrow a same-season map, not the last (autumn) composite', async () => {
  const { seasonalFallbackDate } = await import('../apps/web/js/map-source-window.js');
  // MODIS NDVI 16-day composites: 2025 full year, 2026 only through mid-October.
  const dates = [];
  for (const [year, last] of [[2025, '2025-12-19'], [2026, '2026-10-16']])
    for (let t = Date.parse(`${year}-01-01`); t <= Date.parse(last); t += 16 * 864e5) dates.push(new Date(t).toISOString().slice(0, 10));
  const july = seasonalFallbackDate(dates, '2027-07-15');
  assert.equal(july.slice(0, 7), '2026-07');
  assert.equal(seasonalFallbackDate(dates, '2030-12-15').slice(0, 4), '2025', 'December comes from the last year that has a December map');
  assert.equal(seasonalFallbackDate([], '2030-07-15'), null);
});
