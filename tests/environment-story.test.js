import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { annualStorySeries, resolveStoryVariables, storyBaseline, summarizeStoryMetric, summarizeStoryWater } from '../apps/web/js/environment-story-data.js';
import { attachEnvironmentStory, storyChartData, storyChartSvg, storyMethodHtml, storyMetricHtml, storyValuesHtml, storyWaterHtml, storyFutureHtml, storyClimateComparisonHtml, storyDailyClimateHtml } from '../apps/web/js/environment-story.js';
import { summarizeFutureClimate, summarizeFutureProduct, summarizeFutureTrend } from '../apps/web/js/future-data.js';
import { resolveSiteEvidence } from '../apps/web/js/site-evidence.js';
import { storyFormat } from '../apps/web/js/environment-story-data.js';

test('small changes use familiar decimals instead of scientific notation or a false zero',()=>{
  assert.equal(storyFormat(.08,1,true),'+0.08');
  assert.equal(storyFormat(-.009,2,true),'-0.009');
  assert.equal(storyFormat(.000001,3),'<0.0001');
  assert.equal(storyFormat(0,2),'0');
  assert.equal(storyFormat(null,2),'Unknown');
});

const site = { id: 'test', name: 'Test source', onset: '2005-06' };
function series(from = 2000, to = 2010, values = (year) => year < 2005 ? [10, 8] : [30, 13]) {
  const data = { t: [], site: [], ref: [] };
  for (let year = from; year <= to; year++) for (let month = 1; month <= 12; month++) {
    const [local, nearby] = values(year, month); data.t.push(`${year}-${String(month).padStart(2, '0')}`); data.site.push(local); data.ref.push(nearby);
  }
  return data;
}

test('annual observations require nine months and keep genuine zeros separate from nulls', () => {
  const data = series(2000, 2001, (year, month) => year === 2000 ? [month <= 9 ? 0 : null, 2] : [month <= 8 ? 4 : null, month <= 8 ? 2 : null]);
  const annual = annualStorySeries(data);
  assert.equal(annual[0].site, 0); assert.equal(annual[0].siteMonths, 9); assert.equal(annual[0].local, -2);
  assert.equal(annual[1].site, null); assert.equal(annual[1].local, null); assert.equal(annual[1].pairedMonths, 8);
  assert.equal(annual[0].complete, false);
});

test('baseline is fixed to up to five full calendar years before the comparison start', () => {
  const baseline = storyBaseline(annualStorySeries(series()), site.onset);
  assert.deepEqual(baseline.years, [2000, 2001, 2002, 2003, 2004]); assert.equal(baseline.site, 10); assert.equal(baseline.ref, 8); assert.equal(baseline.local, 2);
  assert.equal(baseline.years.includes(2005), false); assert.equal(storyBaseline([], null).available, false);
});

test('trailing window uses only the selected year and previous two, including nearby change', () => {
  const data = series(2000, 2010, (year) => year < 2005 ? [10, 8] : year <= 2007 ? [30, 13] : [9999, 9999]);
  const summary = summarizeStoryMetric(data, site, 'LST_Day', 2007);
  assert.deepEqual(summary.trailing.years, [2005, 2006, 2007]);
  assert.deepEqual(summary.change, { site: 20, nearby: 5, local: 15 }); assert.equal(summary.status, 'adverse');
  const ndvi = summarizeStoryMetric(series(), site, 'NDVI', 2007); assert.equal(ndvi.status, 'favorable');
  const cooling = summarizeStoryMetric(series(2000, 2010, (year) => year < 2005 ? [10, 8] : [8, 9]), site, 'LST_Day', 2007); assert.equal(cooling.status, 'favorable');
});

test('missing baseline and missing middle years remain unknown rather than fabricated trends', () => {
  const data = series(2000, 2010, (year) => year === 2006 ? [null, null] : [10, 8]);
  const summary = summarizeStoryMetric(data, site, 'LST_Day', 2007);
  assert.equal(summary.trailing, null); assert.equal(summary.change, null); assert.equal(summary.status, 'uncertain'); assert.equal(summary.selected.site, 10);
  const recent = { t: ['2023-09', '2023-10', '2023-11', '2023-12'], site: [1, 2, 3, 4], ref: [1, 1, 1, 1] };
  const short = summarizeStoryMetric(recent, { onset: '2024-06' }, 'NO2', 2025);
  assert.equal(short.baseline.available, false); assert.equal(short.change, null); assert.match(short.baseline.reason, /at least 9 months/);
  assert.doesNotMatch(storyChartSvg(short), /<svg/); // No invented 0–1 axis for an empty chart.
});

test('future years show no annual value, no baseline difference, and no carried-forward forecast', () => {
  const summary = summarizeStoryMetric(series(), site, 'NDVI', 2050, { trendDiff: { p: .001, slope: .1, n: 11 }, first: '2000-01', last: '2010-12' });
  assert.equal(summary.future, true); assert.equal(summary.selected, null); assert.equal(summary.trailing, null); assert.equal(summary.change, null);
  const html = storyMetricHtml(summary); assert.match(html, /No greenness forecast/);assert.match(html,/2050 · Beyond this record/); assert.doesNotMatch(html, /At the site/); assert.match(html, /Regional climate scenarios/);assert.match(html,/data-story-year="2010"/);
  assert.equal(summary.significance.start, '2000'); assert.equal(summary.significance.end, '2010');
});

test('annual chart leaves gaps and marks the sourced comparison start even if the last baseline year is missing', () => {
  const data = series(2000, 2007, (year) => year === 2004 || year === 2006 ? [null, null] : [10 + year - 2000, 8]);
  const summary = summarizeStoryMetric(data, site, 'LST_Day', 2007), html = storyChartSvg(summary, 'year');
  const sitePath = html.match(/<path d="([^"]*)" class="est-line est-site"/)[1];
  assert.equal((sitePath.match(/M/g) || []).length, 3); assert.match(html, /data-story-year="2005"/); assert.match(html, /selected year 2007/);
  assert.equal(summary.onsetYear, 2005); assert.equal(summary.baseline.end, 2003); assert.match(html, /class="est-start"/);
});

test('all five real sites produce bounded baselines and source-specific missing states', () => {
  const sites = JSON.parse(readFileSync(new URL('../data/cloudshadow/sites.json', import.meta.url))).sites;
  for (const place of sites) {
    const vars = JSON.parse(readFileSync(new URL(`../data/cloudshadow/series/${place.id}.json`, import.meta.url))).vars;
    for (const variable of ['NO2_OMI', 'NO2', 'NDVI', 'LST_Day', 'LST_Night']) {
      const summary = summarizeStoryMetric(vars[variable], place, variable, 2025);
      assert.ok(summary.baseline.years.length <= 5); assert.ok(summary.baseline.years.every((y) => y < Number(place.onset.slice(0, 4))));
      if (summary.trailing) assert.deepEqual(summary.trailing.years, [2023, 2024, 2025]);
      const future = summarizeStoryMetric(vars[variable], place, variable, 2050); assert.equal(future.selected, null); assert.equal(future.change, null);
    }
  }
  assert.equal(resolveStoryVariables({ NO2_OMI: {} }, 'LST_Day').air, 'NO2_OMI');
});

test('water summaries use selected-year numeric evidence and never relabel soil as groundwater', () => {
  const results = [{ kind: 'land-water', evidence: 'model-derived', models: [{ model: 'ERA5', metrics: [{ id: 'soil_moisture_0_to_7cm_mean', units: 'm³/m³', series: [{ date: '2025-01-01', value: 0 }, { date: '2025-01-02', value: null }, { date: '2024-01-01', value: 999 }] }, { id: 'precipitation_sum', units: 'mm', series: [{ date: '2025-01-01', value: 2 }, { date: '2025-01-02', value: 4 }] }] }] }, { kind: 'water-quality', evidence: 'ground-observation', station: { id: 'USGS-01646500' }, records: [{ date: '2025-01-01', value: null, valueStatus: 'censored' }, { date: '2025-01-02', value: 0, valueStatus: 'numeric' }, { date: '2024-01-01', value: 999, valueStatus: 'numeric' }] }];
  const water = summarizeStoryWater(results, 2025); assert.equal(water.soil.value, 0); assert.equal(water.soil.days, 1); assert.equal(water.rain.value, 3); assert.equal(water.rain.unit, 'mm/day'); assert.equal(water.groundwater, null); assert.equal(water.station.numeric, 1); assert.equal(water.station.count, 2);
  const future = summarizeStoryWater(results, 2050); assert.equal(future.soil, null); assert.equal(future.station, null);
});

test('water story excludes planned/requested supply and distinguishes peak rates, annual use and consumption', () => {
  const unknown = summarizeStoryWater([], 2024), planned = storyWaterHtml(unknown, resolveSiteEvidence('colossus1', 2024), 2024);
  assert.doesNotMatch(planned, /1\.3 million/); assert.match(planned, /No reported facility total for 2024/);
  const actual = storyWaterHtml(summarizeStoryWater([], 2025), resolveSiteEvidence('colossus1', 2025), 2025); assert.match(actual, /reported peak rate/); assert.match(actual, /not a typical-day average/); assert.match(actual, /about 381,000/);
  const dalles = storyWaterHtml(summarizeStoryWater([], 2021), resolveSiteEvidence('thedalles', 2021), 2021); assert.match(dalles, /355\.1 million/); assert.match(dalles, /almost 275 million/); assert.match(dalles, /Reported consumption/); assert.match(dalles, /Neither is automatically evaporation/);
});

test('missing water totals offer an explicitly dated past report without relabelling it as current use',()=>{
  const missing=storyWaterHtml(summarizeStoryWater([],2025),resolveSiteEvidence('thedalles',2025),2025);
  assert.match(missing,/No reported facility total for 2025/);assert.match(missing,/data-story-year="2021">View 2021 report/);
  const before=storyWaterHtml(summarizeStoryWater([],2024),resolveSiteEvidence('colossus1',2024),2024);
  assert.doesNotMatch(before,/data-story-year="2025"/);
});

test('compact story keeps key figures and source visible while detailed coverage/method stays collapsed', () => {
  const summary = summarizeStoryMetric(series(), site, 'LST_Day', 2007, { trendDiff: { n: 11, p: .03, slope: .2 }, first: '2000-01', last: '2010-12' });
  const key = storyMetricHtml(summary), method = storyMethodHtml(summary);
  assert.match(key, /At the site/); assert.match(key, /Nearby area/); assert.match(key, /Local change since 2000–2004/); assert.match(key, /°C/); assert.match(method, /MODIS/);
  assert.doesNotMatch(key, /Up to five full calendar|12 site months|whole-record test/);
  assert.match(method, /^<details class="est-method"><summary>Data &amp; method/); assert.doesNotMatch(method, /<details[^>]* open/);
  assert.match(method, /12\/12 site months/); assert.match(method, /before the comparison-start/); assert.match(method, /not the selected-year baseline difference/);
});

test('story lifecycle rejects stale facility years and keeps live sampled observations without changing prepared input', () => {
  class Element extends EventTarget {
    innerHTML = ''; attributes = new Map();
    setAttribute(k, v) { this.attributes.set(k, v); }
    remove() { this.removed = true; }
  }
  const eventTarget = new EventTarget(), container = { append(node) { this.node = node; } }, doc = { createElement: () => new Element() }, prepared = {};
  const controller = attachEnvironmentStory({ site: { id: 'thedalles', onset: '2006-01' }, year: 2021, seriesBySite: prepared, container, eventTarget, document: doc });
  assert.equal(controller.state.facility.year, 2021);
  eventTarget.dispatchEvent(new CustomEvent('cs:facility-evidence', { detail: { siteId: 'thedalles', year: 2017, water: { records: [] } } }));
  assert.equal(controller.state.facility.year, 2021);
  eventTarget.dispatchEvent(new CustomEvent('cs:year', { detail: { siteId: 'thedalles', year: 2025 } }));
  assert.equal(controller.state.facility.year, 2025);
  eventTarget.dispatchEvent(new CustomEvent('cs:location', { detail: { site: { id: 'point-live', name: 'Selected location', lat: 35, lon: -90 } } }));
  controller.setYear(2007);
  controller.setAnalysis('LST_Day', series(), 'point-live');
  assert.equal(controller.state.observations.get('point-live').LST_Day.site[0], 10); assert.deepEqual(prepared, {}); assert.match(container.node.innerHTML, /<svg/);
  controller.destroy(); eventTarget.dispatchEvent(new CustomEvent('cs:year', { detail: { year: 2030 } }));
  assert.equal(controller.state.year, 2007); assert.equal(container.node.removed, true);
});

test('the chart preserves the observed domain when a future year is selected',()=>{
  const summary=summarizeStoryMetric(series(),site,'NDVI',2039),html=storyChartSvg(summary);
  assert.match(html,/data-first-year="2000" data-last-year="2010"/);
  assert.doesNotMatch(html,/data-story-year="2039"|class="est-cursor"|est-future/);
  assert.match(html,/selected year 2039, outside the observed record/);
});

test('expanded chart uses the available horizontal space without changing its source values',()=>{
  const summary=summarizeStoryMetric(series(),site,'NDVI',2007);
  const regular=storyChartSvg(summary),expanded=storyChartSvg(summary,'trend',{expanded:true});
  assert.match(regular,/viewBox="0 0 400 260"/);assert.match(expanded,/viewBox="0 0 720 260"/);
  assert.deepEqual([...regular.matchAll(/<title>(.*?)<\/title>/g)].map(m=>m[1]),[...expanded.matchAll(/<title>(.*?)<\/title>/g)].map(m=>m[1]));
});

test('annual readout, plotted points and numeric table all compare the same matching months',()=>{
  const data=series(2000,2010,(year,month)=>year===2007&&month===1?[900,null]:year<2005?[10,8]:[30,13]);
  const summary=summarizeStoryMetric(data,site,'LST_Day',2007);
  assert.equal(summary.selected.site,102.5); // Independent mean is intentionally different.
  assert.equal(storyChartData(summary,'year').points.find(p=>p.year===2007).site,30);
  assert.match(storyMetricHtml(summary,'year'),/<strong>30<\/strong>/);
  assert.doesNotMatch(storyMetricHtml(summary,'year'),/102\.5/);
  assert.match(storyValuesHtml(summary,'year'),/<th scope="row">2007<\/th><td>30<\/td><td>13<\/td>/);
  assert.equal(summary.selectedChange.local,15);
});

test('the readable value table retains zeros and missing-year gaps in the chosen averaging mode',()=>{
  const data=series(2000,2003,year=>year===2001?[null,null]:[0,2]);
  const summary=summarizeStoryMetric(data,site,'NDVI',2003),table=storyValuesHtml(summary,'year');
  assert.match(table,/<th scope="row">2000<\/th><td>0<\/td><td>2<\/td>/);
  assert.match(table,/<th scope="row">2001<\/th><td>Unknown<\/td><td>Unknown<\/td>/);
  assert.equal(storyValuesHtml(summary,'trend'),'');
});

test('future view has four plain category controls and an actionable supported-model pane',()=>{
  class Element extends EventTarget{innerHTML='';setAttribute(){}remove(){}}
  const container={append(node){this.node=node;}},eventTarget=new EventTarget(),doc={createElement:()=>new Element()};
  const controller=attachEnvironmentStory({site,year:2039,varId:'NDVI',seriesBySite:{[site.id]:{NDVI:series()}},container,eventTarget,document:doc});
  const html=container.node.innerHTML;
  assert.equal((html.match(/data-story-group=/g)||[]).length,4);
  assert.match(html,/Agricultural climate exposure/);
  assert.doesNotMatch(html,/est-cards|No annual site forecast|Coverage or baseline is incomplete|<svg/);
  assert.match(html,/data-story-future-request="agriculture"/);assert.doesNotMatch(html,/No greenness forecast/);
  controller.destroy();
});

const preparedClimate=JSON.parse(readFileSync(new URL('../data/cloudshadow/projections/thedalles.json',import.meta.url)));
function futureState(year=2050,scenario='ssp245'){
  return {siteId:'thedalles',year,scenario,climate:summarizeFutureProduct('climate-projection',preparedClimate,{year,scenario}),products:{'climate-projection':preparedClimate}};
}
test('main future heat and water panes show the actual Python climate values, periods and model ranges',()=>{
  for(const scenario of ['ssp245','ssp585'])for(const year of [2039,2050,2090]){
    const future=futureState(year,scenario),heat=storyFutureHtml('heat',future),water=storyFutureHtml('water',future);
    const temp=summarizeFutureClimate(preparedClimate,{year,scenario,metric:'meanTempC'}),rain=summarizeFutureClimate(preparedClimate,{year,scenario,metric:'precipMmPerYear'});
    assert.match(heat,new RegExp(storyFormat(temp.value,1).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.ok(water.includes(storyFormat(rain.value,0)));assert.ok(heat.includes(temp.period.label));assert.ok(water.includes(rain.period.label));
    assert.match(heat,/Very hot days/);assert.match(heat,/Model range/);assert.match(water,/River levels, groundwater depletion and water quality are not predicted/);
    assert.doesNotMatch(heat+water,/No .* forecast/);
    assert.match(heat,new RegExp(`value="${scenario}" selected`));
  }
  assert.notEqual(storyFutureHtml('heat',futureState(2090,'ssp245')),storyFutureHtml('heat',futureState(2090,'ssp585')));
  const table=storyClimateComparisonHtml(futureState(),'meanTempC');assert.match(table,/1995–2014 · baseline/);assert.match(table,/2041–2060/);assert.match(table,/2081–2100/);
});
test('future zero rainfall is a value while missing products expose computation, not invented numbers',()=>{
  const zero=structuredClone(preparedClimate);zero.metrics.precipMmPerYear.ssp245_2041_2060.value={median:0,min:0,max:0};
  const html=storyFutureHtml('water',{year:2050,scenario:'ssp245',products:{'climate-projection':zero}});
  assert.match(html,/<strong>0<small>mm \/ year/);assert.match(html,/Model range <b>0 to 0/);
  const absent=storyFutureHtml('heat',{year:2050,scenario:'ssp245'});assert.match(absent,/data-story-future-request="climate-projection"/);assert.doesNotMatch(absent,/est-future-card/);
});
test('future air exposes the actual source-screening output without claiming future ambient concentrations',()=>{
  const raw=JSON.parse(readFileSync(new URL('../data/cloudshadow/plumes/colossus1.json',import.meta.url)));
  const html=storyFutureHtml('air',{year:2050,products:{'plume-scenario':raw}});
  assert.ok(html.includes(raw.peak.chiOverQ.toExponential(2)));assert.ok(html.includes(raw.receptors[0].chiOverQ.toExponential(2)));
  assert.match(html,/not an annual air-quality forecast/);assert.match(html,/Show dispersion in 3D/);assert.match(html,/No sourced emission rate supplied/);assert.match(html,/2018/);
});
test('air concentration needs a positive sourced emission and receptor units match the selected result',()=>{
  const raw=JSON.parse(readFileSync(new URL('../data/cloudshadow/plumes/colossus1.json',import.meta.url)));
  raw.peak.concentrationUgM3=42;raw.receptors[0].concentrationUgM3=7;
  for(const emission of [undefined,{rateGs:1,source:''},{rateGs:1,source:'  '},{rateGs:0,source:'Permit'},{rateGs:-1,source:'Permit'},{rateGs:'1',source:'Permit'}]){
    raw.emission=emission;const html=storyFutureHtml('air',{year:2050,products:{'plume-scenario':raw}});
    assert.doesNotMatch(html,/µg\/m³|Peak source contribution/);assert.match(html,/Peak dilution per unit emission/);assert.match(html,/s\/m³ · χ\/Q/);
    assert.ok(html.includes(raw.receptors[0].chiOverQ.toExponential(2)));
  }
  raw.emission={rateGs:1,source:'Permit example'};
  const sourced=storyFutureHtml('air',{year:2050,products:{'plume-scenario':raw}});
  assert.match(sourced,/Peak source contribution/);assert.match(sourced,/<strong>42<small>µg\/m³/);assert.match(sourced,/Source-only concentration · µg\/m³/);assert.match(sourced,/Boxtown<\/th><td>7<\/td>/);
});
test('future vegetation shows supported exposure values and keeps mismatched model periods explicit',()=>{
  const raw={futurePeriod:{start:'2035-01-01',end:'2039-12-31'},baselinePeriod:{start:'2000-01-01',end:'2004-12-31'},comparisons:[{model:'Example',indicators:{heatThresholdDays:{baselineMeanPerSeason:0,futureMeanPerSeason:0,change:0},dryThresholdDays:{baselineMeanPerSeason:2,futureMeanPerSeason:null,change:null}}}],settings:{growingMonths:[4,5,6],heatThresholdC:35,dryDayThresholdMm:1}};
  const current=storyFutureHtml('vegetation',{year:2037,products:{agriculture:raw}});
  assert.match(current,/Very hot days/);assert.match(current,/<strong>0 <small>days \/ season/);assert.match(current,/Unknown <small>days \/ season/);
  assert.doesNotMatch(current,/data-story-future-request="agriculture"/);
  const later=storyFutureHtml('vegetation',{year:2050,products:{agriculture:raw}});assert.match(later,/covers 2035–2039, not 2050/);assert.match(later,/supported 2045–2049/);assert.match(later,/data-story-year="2049"/);
});
test('future trend extensions show existing annual rows through 2035 and never carry them beyond the horizon',()=>{
  const raw=JSON.parse(readFileSync(new URL('../data/cloudshadow/unreal/timeline/thedalles.json',import.meta.url)));
  const trend=summarizeFutureTrend(raw,{year:2030,variable:'NDVI'}),html=storyFutureHtml('vegetation',{year:2030,trend},'NDVI');
  assert.match(html,/If the historical trend continues · 2030/);assert.ok(html.includes(storyFormat(trend.variables.NDVI.value,3)));
  assert.match(html,/not a prediction interval/);assert.doesNotMatch(storyFutureHtml('vegetation',{year:2050,trend},'NDVI'),/If the historical trend continues · 2050/);
});
test('daily climate summaries retain source models, require complete years and never sum partial rainfall',()=>{
  const points=Array.from({length:365},(_,i)=>({date:new Date(Date.UTC(2035,0,i+1)).toISOString().slice(0,10),value:1}));
  const raw={models:[{model:'Full',metrics:[{id:'precipitation_sum',units:'mm',series:points}]},{model:'Partial',metrics:[{id:'precipitation_sum',units:'mm',series:points.slice(1)}]}]};
  const html=storyDailyClimateHtml({year:2035,products:{climate:raw}},'water');
  assert.match(html,/Full<\/th><td>365<\/td><td>365\/365/);assert.match(html,/Partial<\/th><td>Unknown<\/td><td>364\/365/);assert.match(html,/not forecast weather on specific future days/);
});
test('future model results reach the main readout and old site products never replace the selected site',()=>{
  class Element extends EventTarget{innerHTML='';setAttribute(){}remove(){}}
  const container={append(node){this.node=node;}},eventTarget=new EventTarget(),doc={createElement:()=>new Element()};
  const controller=attachEnvironmentStory({site:{id:'thedalles',name:'The Dalles'},year:2050,varId:'LST_Day',futureState:futureState(),container,eventTarget,document:doc});
  assert.match(container.node.innerHTML,/Regional air temperature/);assert.match(container.node.innerHTML,/2041–2060/);
  eventTarget.dispatchEvent(new CustomEvent('cs:future-state',{detail:{state:futureState(2090,'ssp585')}}));controller.setYear(2090);
  assert.match(container.node.innerHTML,/2081–2100/);assert.match(container.node.innerHTML,/value="ssp585" selected/);
  controller.setSite({id:'other',name:'Other'});assert.doesNotMatch(container.node.innerHTML,/est-future-card/);
  eventTarget.dispatchEvent(new CustomEvent('cs:future-state',{detail:{state:futureState()}}));assert.doesNotMatch(container.node.innerHTML,/est-future-card/);
  controller.setSite({id:'thedalles',name:'The Dalles'});assert.match(container.node.innerHTML,/est-future-card/);
  controller.destroy();
});
