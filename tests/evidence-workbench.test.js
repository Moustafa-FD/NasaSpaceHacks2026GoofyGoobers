import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateScreeningRequest} from '../packages/contracts/src/screening.ts';
import {buildWorkbenchRequest,regionalEvidenceChartHtml,regionalEvidenceHtml,regionalTrendHtml,siteAuditHtml,facilityInventoryHtml,screeningResultsHtml,attachEvidenceWorkbench} from '../apps/web/js/evidence-workbench.js';
const site={id:'thedalles',lat:45.6241,lon:-121.2071,name:'Google The Dalles'};
const source={evidence:'assumed',citation:'Synthetic unit-test assumptions; no real facility values.'};

test('missing-input requests send no invented facility defaults while guided zero values remain real inputs',()=>{
  const empty=buildWorkbenchRequest({site,year:2035},{missingOnly:true});assert.deepEqual(empty.years,[{year:2035}]);assert.equal(empty.dispersion,undefined);assert.deepEqual(validateScreeningRequest(empty),[]);
  const heat=buildWorkbenchRequest({site,year:2035,domain:'heat',values:{heatMw:'0',effectiveHeightM:'20',airDensityKgM3:'1.2',specificHeatJkgK:'1005'},...source});
  assert.equal(heat.years[0].heatMw,0);assert.equal(heat.dispersion.airDensityKgM3,1.2);assert.equal(heat.years[0].emissionRateGs,undefined);assert.deepEqual(validateScreeningRequest(heat),[]);
  assert.throws(()=>buildWorkbenchRequest({site,year:2035,domain:'heat',values:{heatMw:'10'}}),/citation/);
  assert.throws(()=>buildWorkbenchRequest({site,year:2035,domain:'heat',values:{heatMw:''},...source}),/Enter sourced/);
});

test('water, air and noise forms retain independent units, source statements and supported comparison contours',()=>{
  const air=buildWorkbenchRequest({site,year:2040,domain:'air',values:{emissionRateGs:'0',pollutant:'NOx',effectiveHeightM:'20'},...source});assert.equal(air.years[0].emissionRateGs,0);assert.equal(air.years[0].pollutant,'NOx');assert.deepEqual(validateScreeningRequest(air),[]);
  const water=buildWorkbenchRequest({site,year:2040,domain:'water',values:{withdrawalM3s:'.2',returnM3s:'.1',riverFlowM3s:'10',upstreamTempC:'20',dischargeTempC:'25',upstreamMgL:'0',dischargeMgL:'1',pollutant:'Conservative test constituent'},...source});assert.equal(water.years[0].upstreamMgL,0);assert.deepEqual(validateScreeningRequest(water),[]);
  const noise=buildWorkbenchRequest({site,year:2040,domain:'noise',values:{soundPowerDbA:'90',receptorDistanceM:'100',backgroundDbA:'0',noiseContours:'40, 50 60'},...source});assert.equal(noise.backgroundNoise.dbA,0);assert.deepEqual(noise.noiseContourLevelsDbA,[40,50,60]);assert.deepEqual(validateScreeningRequest(noise),[]);
  assert.throws(()=>buildWorkbenchRequest({site,year:2040,domain:'noise',values:{soundPowerDbA:'90',noiseContours:'40,40'},...source}),/unique/);
  assert.throws(()=>buildWorkbenchRequest({site,year:2040,domain:'noise',values:{soundPowerDbA:'Infinity'},...source}),/between/);
});

test('advanced source requests cannot silently target another study site or leak credentials in a URL',()=>{
  const base=buildWorkbenchRequest({site,year:2031},{missingOnly:true});
  assert.deepEqual(buildWorkbenchRequest({site,year:2031,advancedJson:JSON.stringify(base)}),base);
  assert.throws(()=>buildWorkbenchRequest({site,year:2031,advancedJson:JSON.stringify({...base,siteId:'ashburn'})}),/selected/);
  assert.throws(()=>buildWorkbenchRequest({site,year:2010},{missingOnly:true}),/2020/);
  assert.throws(()=>buildWorkbenchRequest({site,year:2031,domain:'noise',values:{soundPowerDbA:90},...source,url:'https://secret:password@example.org'}),/credentials/);
  const point={id:'point-test',lat:40,lon:-80};const request=buildWorkbenchRequest({site:point,year:2031},{missingOnly:true});assert.deepEqual(request.point,{latitude:40,longitude:-80});
});

test('regional chart and readout keep recorded zero, missing-year gaps, source dates and source-resolution labels',()=>{
  const chart=regionalEvidenceChartHtml({label:'Synthetic test',unit:'mm',annual:[{year:2020,value:0},{year:2021,value:null},{year:2022,value:10}]});assert.match(chart,/2020 to 2022/);const path=chart.match(/<path d="([^"]*)"/)[1];assert.equal((path.match(/M/g)||[]).length,2);assert.doesNotMatch(path,/L/);
  const regional=JSON.parse(readFileSync(new URL('../data/cloudshadow/regional-evidence/thedalles.json',import.meta.url)));
  const observed=regionalEvidenceHtml(regional,{year:2025,variable:'power-precipitation'});assert.match(observed,/NASA source/);assert.match(observed,/Python trend analysis/);assert.match(observed,/regional/);
  const future=regionalEvidenceHtml(regional,{year:2090,variable:'power-precipitation'});assert.match(future,/Unknown/);assert.match(future,/no value is carried/);assert.match(future,/View 2025 source data/);assert.match(future,/data-ew-scenario-year="2025"/);
  const trend=regionalTrendHtml({summary:'Synthetic historical trend',period:{start:'2003',end:'2025'},alpha:.05,sen:{slopePerDecade:0,ciPerDecade:[-1,1]},mannKendall:{pValue:.5}},'mm/year');
  assert.ok(trend.indexOf('Synthetic historical trend')<trend.indexOf('<details>'));assert.ok(trend.indexOf('Rate: 0')<trend.indexOf('<details>'));assert.match(trend,/Mann–Kendall p = 0.5/);assert.match(trend,/95% Sen slope interval: -1 to 1 mm\/year per decade/);assert.match(trend,/not a selected-year difference/);
  const unavailable=regionalEvidenceHtml(regional,{year:2025,variable:'giovanni-groundwater'});assert.match(unavailable,/Unknown/);assert.match(unavailable,/not present|No source|source record/i);
});

test('source coverage shows actual dated gauges and never presents their 2025 flow as a 2050 measurement',()=>{
  const audit=JSON.parse(readFileSync(new URL('../data/cloudshadow/site-audit/thedalles.json',import.meta.url)));
  const history=siteAuditHtml(audit,2025);assert.match(history,/USGS-14105700/);assert.match(history,/365\/365/);assert.match(history,/Show source gauges/);assert.match(history,/not automatically joined/);
  const future=siteAuditHtml(audit,2050);assert.match(future,/No sufficiently complete acquired discharge record for 2050/);assert.doesNotMatch(future,/data-ew-water-map/);assert.match(future,/View 2025 gauge data/);assert.match(future,/data-ew-scenario-year="2025"/);
});

test('screening output keeps missing inputs, selected scenario years and escaped source labels',()=>{
  const result={years:[{year:2035,metrics:[{id:'noise',label:'<script>bad</script>',value:0,unit:'dB(A)'}]}],requiredInputs:[{year:2035,domain:'waterBalance',fields:['withdrawalM3s'],reason:'Missing input'}],uncertainty:{note:'Uncertainty not quantified.'}};
  const html=screeningResultsHtml({result},2035);assert.match(html,/>0 <small>/);assert.match(html,/withdrawalM3s/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  const other=screeningResultsHtml({result},2040);assert.match(other,/No screening record for 2040/);assert.doesNotMatch(other,/ew-result/);assert.match(other,/data-ew-scenario-year="2035"/);assert.match(other,/View 2035 scenario/);
  result.years[0].noiseContours=[{levelDbA:40,radiusM:89.1,status:'conditional-screening'},{levelDbA:50,radiusM:20000,status:'outside-supported-distance'}];
  const contours=screeningResultsHtml({result},2035);assert.match(contours,/Chosen comparison levels/);assert.match(contours,/>89\.1<\/td>/);assert.match(contours,/>Unknown<\/td><td>outside-supported-distance/);assert.doesNotMatch(contours,/>20,000<\/td>/);
  result.years[0].metrics[0].value=1e-8;assert.match(screeningResultsHtml({result},2035),/1\.00e-8/);
  const inventory=facilityInventoryHtml({emissions:[{year:2023,pollutant:{name:'Synthetic pollutant'},amount:1e-8,unit:'LB'},{year:2020,pollutant:{name:'Older row'},amount:0,unit:'TON'}]});assert.match(inventory,/2023 reported/);assert.match(inventory,/1\.00e-8/);assert.doesNotMatch(inventory,/Older row/);assert.match(inventory,/not added/);
});

function fakeNode(){return {innerHTML:'',textContent:'',hidden:false,value:'',events:new Map(),addEventListener(n,f){this.events.set(n,f);},removeEventListener(n){this.events.delete(n);},setAttribute(){},append(){},remove(){this.removed=true;},contains(){return true;}};}
test('incoming model progress preserves in-progress form inputs and explicit year; site changes clear the old scenario',()=>{
  const nodes=Object.fromEntries(['[data-ew-form]','[data-ew-fields]','[data-ew-regional]','[data-ew-audit]','[data-ew-results]','[data-ew-variable]','[data-ew-status]','[data-ew-screening-map]'].map(k=>[k,fakeNode()])),controls=new Map();
  const form=nodes['[data-ew-form]'];form.elements={namedItem(name){if(!controls.has(name))controls.set(name,{value:''});return controls.get(name);}};form.querySelectorAll=()=>[];form.reset=()=>{for(const input of controls.values())input.value='';};
  const root=fakeNode();root.querySelector=s=>nodes[s];const doc={createElement:()=>root,querySelector:()=>null,head:null},events=new EventTarget();
  const selections=[];const controller=attachEvidenceWorkbench({site,year:2035,futureState:{site,siteId:site.id,year:2035},document:doc,eventTarget:events,container:{append(){}},onSelectYear:year=>selections.push(year)});
  const jump={hasAttribute:n=>n==='data-ew-scenario-year',getAttribute:()=> '2042'};root.events.get('click')({target:{closest:()=>jump}});assert.deepEqual(selections,[2042]);
  const historical={...jump,getAttribute:()=> '2010'};root.events.get('click')({target:{closest:()=>historical}});assert.deepEqual(selections,[2042,2010]);
  form.elements.namedItem('heatMw').value='25';form.elements.namedItem('year').value='2040';root.events.get('input')({target:{name:'year'}});
  controller.setState({site,siteId:site.id,year:2036,pending:true,status:'Running'});assert.equal(form.elements.namedItem('heatMw').value,'25');assert.equal(form.elements.namedItem('year').value,'2040');
  const next={...site,id:'ashburn'};controller.setState({site:next,siteId:next.id,year:2050});assert.equal(form.elements.namedItem('heatMw').value,'');assert.equal(form.elements.namedItem('year').value,'2050');
  controller.destroy();assert.equal(root.removed,true);
});

test('one calculation covers 2020–2035 by default with the same inputs, and results follow the timeline', async () => {
  const { workbenchYears, yearRanges } = await import('../apps/web/js/evidence-workbench.js');
  assert.deepEqual(workbenchYears(2025, 'through2035'), Array.from({ length: 16 }, (_, i) => 2020 + i));
  assert.deepEqual(workbenchYears(2040, 'single'), [2040]);
  assert.equal(yearRanges([2020, 2021, 2022, 2035, 2050, 2051]), '2020–2022, 2035, 2050–2051');
  const body = buildWorkbenchRequest({ site, year: 2025, domain: 'heat', values: { heatMw: '25', effectiveHeightM: '20' }, span: 'through2035', ...source });
  assert.equal(body.years.length, 16); assert.ok(body.years.every((r) => r.heatMw === 25)); assert.deepEqual(validateScreeningRequest(body), []);
  const late = buildWorkbenchRequest({ site, year: 2050, domain: 'heat', values: { heatMw: '25' }, span: 'through2035', ...source });
  assert.ok(late.years.some((r) => r.year === 2050), 'the chosen year is always included');
  const raw = { years: body.years.map((r) => ({ year: r.year, metrics: [{ label: 'Heat', value: 1, unit: 'W' }] })) };
  assert.match(screeningResultsHtml(raw, 2031), /2031 · conditional screening/);
  assert.match(screeningResultsHtml(raw, 2031), /same supplied inputs each year/);
  assert.match(screeningResultsHtml(raw, 2050), /Calculate 2050 with the same inputs/);
  assert.match(screeningResultsHtml(raw, 2012), /start in 2020/);
});

test('moving the timeline updates the scenario year even after it was typed', () => {
  const nodes=Object.fromEntries(['[data-ew-form]','[data-ew-fields]','[data-ew-regional]','[data-ew-audit]','[data-ew-results]','[data-ew-variable]','[data-ew-status]','[data-ew-screening-map]'].map(k=>[k,fakeNode()])),controls=new Map();
  const form=nodes['[data-ew-form]'];form.elements={namedItem(name){if(!controls.has(name))controls.set(name,{value:''});return controls.get(name);}};form.querySelectorAll=()=>[];form.reset=()=>{for(const input of controls.values())input.value='';};
  const root=fakeNode();root.querySelector=s=>nodes[s];const doc={createElement:()=>root,querySelector:()=>null,head:null},events=new EventTarget();
  const controller=attachEvidenceWorkbench({site,year:2025,futureState:{site,siteId:site.id,year:2025},document:doc,eventTarget:events,container:{append(){}}});
  form.elements.namedItem('year').value='2030';root.events.get('input')({target:{name:'year'}});
  controller.setState({site,siteId:site.id,year:2025});assert.equal(form.elements.namedItem('year').value,'2030','same year: the typed value stays');
  controller.setState({site,siteId:site.id,year:2033});assert.equal(form.elements.namedItem('year').value,'2033','slider moved: the form follows');
  controller.destroy();
});
