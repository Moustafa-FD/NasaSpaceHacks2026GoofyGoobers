import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {futureTimelineSummary} from '../apps/web/js/future-timeline.js';
import {resolveWindReadout} from '../apps/web/js/flowfield.js';

const annual=(changes={})=>({siteId:'a',year:2050,climateView:'annual',power:{available:true,year:2050,temperatureC:21.4,precipitationMm:990,scenario:'ssp370'},...changes});

test('annual future timeline uses actual regional units and retains source pathway without relabelling the site graph',()=>{
  const output=futureTimelineSummary(annual(),{siteId:'a',year:2050,currentYear:2026});
  assert.equal(output.badge,'CLIMATE SIMULATION · ANNUAL');
  assert.deepEqual(output.chips,[{label:'Regional air',value:21.4,digits:1,unit:'°C'},{label:'Regional precipitation',value:990,digits:0,unit:'mm/year'}]);
  assert.match(output.pathway,/SSP3-7\.0/);assert.doesNotMatch(output.pathway,/SSP5/);
  assert.match(output.aria,/not observed weather/);
  assert.match(output.trendText,/site history; annual regional data above/);
  assert.match(output.trendTitle,/not future local site-minus-surroundings/);
});

test('future timeline refuses stale, historical, period, missing and nonfinite annual products but preserves real zero',()=>{
  for(const state of [annual({siteId:'b'}),annual({year:2051}),annual({climateView:'period'}),annual({power:{available:false,year:2050,temperatureC:20}}),annual({power:{available:true,year:2051,temperatureC:20}}),annual({power:{available:true,year:2050,temperatureC:null,precipitationMm:NaN}})]){
    assert.equal(futureTimelineSummary(state,{siteId:'a',year:2050,currentYear:2026}),null);
  }
  assert.equal(futureTimelineSummary(annual({year:2025,power:{available:true,year:2025,temperatureC:20}}),{siteId:'a',year:2025,currentYear:2026}),null);
  const zero=futureTimelineSummary(annual({power:{available:true,year:2050,temperatureC:null,precipitationMm:0}}),{siteId:'a',year:2050,currentYear:2026});
  assert.equal(zero.chips.length,1);assert.equal(zero.chips[0].value,0);assert.equal(zero.chips[0].unit,'mm/year');
});

test('timeline HUD reads initial shared annual state, clears stale years and restores period mode without changing scientific phase',()=>{
  const nodes=new Map(),events=[],phases=[];
  const drawing=new Proxy({},{get:(target,key)=>key in target?target[key]:(()=>{})});
  const element=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{textContent:'',innerHTML:'',attributes:{},setAttribute(key,value){this.attributes[key]=value;},getBoundingClientRect:()=>({width:300}),getContext:()=>drawing});
    return nodes.get(selector);
  };
  const context={futureTimelineSummary,resolveWindReadout,initialFuture:annual(),VARS:{LST_Night:{digits:2,unit:'°C'}},FX:{applyYear(_year,_row,phase){phases.push(phase);}},window:{addEventListener(){},dispatchEvent:event=>events.push(event)},
    CustomEvent:class{constructor(type,options){Object.assign(this,{type,...options});}},document:{querySelector:element,body:{classList:{toggle(){}}}},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+`\nwindow.CloudShadow={future:{state:initialFuture}};setGround=()=>{};CS={};T.site={id:'a'};globalThis.hooks={paint:year=>applyYear(year),setFuture:state=>window.CloudShadow.future.state=state};`,context);
  context.hooks.paint(2050);
  assert.equal(element('#tlPhase').textContent,'CLIMATE SIMULATION · ANNUAL');
  assert.match(element('#tlChips').innerHTML,/21\.4<\/b> °C/);
  assert.match(element('#tlChips').innerHTML,/990<\/b> mm\/year/);
  assert.match(element('#tlSlider').attributes['aria-valuetext'],/annual regional climate simulation/);
  assert.match(element('#tlTrendValue').textContent,/site history; annual regional data above/);
  assert.equal(phases.at(-1),'climate');assert.equal(events.at(-1).detail.phase,'climate');
  assert.equal(Object.keys(events.at(-1).detail.row).length,0);
  context.hooks.paint(2051);
  assert.equal(element('#tlPhase').textContent,'CLIMATE SCENARIO · PERIOD SUMMARY');
  assert.doesNotMatch(element('#tlChips').innerHTML,/21\.4/);
  context.hooks.setFuture(annual({climateView:'period'}));context.hooks.paint(2050);
  assert.equal(element('#tlPhase').textContent,'CLIMATE SCENARIO · PERIOD SUMMARY');
  assert.match(element('#tlTrendValue').textContent,/climate period, no annual site signal/);
  context.hooks.setFuture(annual());context.hooks.paint(2025);
  assert.equal(element('#tlPhase').textContent,'OBSERVED');
  assert.doesNotMatch(element('#tlChips').innerHTML,/Regional air|Regional precipitation|21\.4/);
});
