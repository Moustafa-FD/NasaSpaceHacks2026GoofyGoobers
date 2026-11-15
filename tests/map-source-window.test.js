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
