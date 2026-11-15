import test from 'node:test';
import assert from 'node:assert/strict';
import { electricityComparisonText, electricityChartSegments, electricityPhaseText, electricityViewState, waterPricePresentation } from '../apps/web/js/electricity-ui.js';

test('future water reference keeps its published year and never becomes a forecast or measured average', () => {
  const shown = waterPricePresentation({kind:'reference',rateYear:2026,monthlyBillUsd:33.25,monthlyGallons:3000},2035);
  assert.equal(shown.bill,'$33.25');
  assert.match(shown.usage,/3,000 US gal\/month example · water only/);
  assert.equal(shown.status,'Published 2026 rate · reference for 2035, not a forecast');
  assert.equal(waterPricePresentation({kind:'reference',rateYear:null,monthlyBillUsd:25,monthlyGallons:3000},2035).status,'Published rate · date unspecified · reference for 2035, not a forecast');
  assert.equal(waterPricePresentation({kind:'reported',rateYear:2027,monthlyBillUsd:27,monthlyGallons:3000,scheduled:true},2027).status,'Approved scheduled 2027 water tariff');
  const missing = waterPricePresentation({kind:'unavailable',monthlyBillUsd:null,reason:'No verified tariff.'},2035);
  assert.equal(missing.bill,'Unavailable'); assert.equal(missing.status,'No verified tariff.');
});

test('enabling electricity leaves optional details closed, and closing details keeps the card active', () => {
  const enabled = electricityViewState({active:false,detailsOpen:false},{type:'activate',active:true});
  assert.deepEqual(enabled,{active:true,detailsOpen:false});
  const details = electricityViewState(enabled,{type:'open-details'});
  assert.deepEqual(details,{active:true,detailsOpen:true});
  assert.deepEqual(electricityViewState(details,{type:'close-details'}),{active:true,detailsOpen:false});
  assert.deepEqual(electricityViewState(details,{type:'activate',active:false}),{active:false,detailsOpen:false});
});

test('electricity comparisons preserve decreases and missing evidence', () => {
  assert.equal(electricityComparisonText({kind:'observed',changePct:-4.25,baselineYear:2023}), '4.3% lower electricity price vs 2023');
  assert.equal(electricityComparisonText({kind:'projected',changePct:18,baselineYear:2023}), '18.0% higher electricity price vs 2023');
  assert.equal(electricityComparisonText({kind:'unavailable',changePct:0,baselineYear:2023}), 'No price comparison available');
  assert.equal(electricityComparisonText({kind:'observed',changePct:null,baselineYear:2023}), 'No price comparison available');
});

test('price chart does not draw across missing records and distinguishes projected segments', () => {
  const points = [
    {year:2021,kind:'observed',priceCentsKwh:12}, {year:2022,kind:'unavailable',priceCentsKwh:null},
    {year:2023,kind:'observed',priceCentsKwh:13}, {year:2024,kind:'observed',priceCentsKwh:14},
    {year:2025,kind:'projected',priceCentsKwh:15}, {year:2026,kind:'projected',priceCentsKwh:16},
  ];
  const segments = electricityChartSegments(points);
  assert.deepEqual(segments.observed.map((s) => s.map((p) => p.year)), [[2021],[2023,2024]]);
  assert.deepEqual(segments.projected.map((s) => s.map((p) => p.year)), [[2024,2025,2026]]);
});

test('timeline wording keeps pre-start, post-start and projected status separate', () => {
  assert.equal(electricityPhaseText({year:2023,kind:'observed'},2024), 'Before site milestone · Recorded');
  assert.equal(electricityPhaseText({year:2024,kind:'observed'},2024), 'Since site milestone · Recorded');
  assert.equal(electricityPhaseText({year:2030,kind:'projected'},2024), 'Since site milestone · Projected');
  assert.equal(electricityPhaseText({year:2100,kind:'unavailable'},2024), 'No estimate for this year');
});
