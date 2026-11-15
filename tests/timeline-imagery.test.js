import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function harness(){
  const layers=[],providers=[],frames=[],caption={textContent:''};
  const viewer={camera:{positionCartographic:{height:10000000}},imageryLayers:{
    addImageryProvider(provider){const layer={provider};layers.push(layer);return layer;},
    contains:layer=>layers.includes(layer),remove(layer){layers.splice(layers.indexOf(layer),1);},
  }};
  const context={Cesium:{Rectangle:{fromDegrees:(...bounds)=>bounds},UrlTemplateImageryProvider:class{constructor(options){Object.assign(this,options);providers.push(this);}}},
    performance:{now:()=>0},requestAnimationFrame:callback=>frames.push(callback),getMotionSpeed:()=>1,
    window:{addEventListener(){}},document:{querySelector:()=>caption},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+`\nglobalThis.hooks={setGround,syncGroundVisibility,groundVisibility,clearGround,seed(v,site,data){viewer=v;T.site=site;hlsTimeline=data;}};`,context);
  return {...context.hooks,viewer,layers,providers,caption,finishFade(){for(let step=1;step<=8&&frames.length;step++){const pending=frames.splice(0);for(const callback of pending)callback(step*100);}}};
}
const snapshots={a:{2025:{date:'2025-07-15',templateUrl:'https://source/{z}/{y}/{x}.png'}},b:{2025:{date:'2025-07-15',templateUrl:'https://source/{z}/{y}/{x}.png'}}};

test('default HLS is geographically clipped and fully hidden from full-Earth view despite completed crossfade',()=>{
  const h=harness();h.seed(h.viewer,{id:'a',lat:39,lon:-77},snapshots);
  h.setGround(2025);h.finishFade();
  assert.deepEqual(h.providers[0].rectangle,[-77.2,38.85,-76.8,39.15]);
  assert.equal(h.layers[0].alpha,0);assert.equal(h.layers[0].show,false);
  h.viewer.camera.positionCartographic.height=100000;h.syncGroundVisibility();
  assert.equal(h.layers[0].alpha,.5);assert.equal(h.layers[0].show,true);
  h.viewer.camera.positionCartographic.height=80000;h.syncGroundVisibility();
  assert.equal(h.layers[0].alpha,1);
  h.viewer.camera.positionCartographic.height=120000;h.syncGroundVisibility();
  assert.equal(h.layers[0].alpha,0);assert.equal(h.layers[0].show,false);
  for(const height of [80000,90000,100000,110000,120000])assert.ok(h.groundVisibility(height)>=0&&h.groundVisibility(height)<=1);
});

test('shared HLS URLs keep distinct site extents and future years retain ungraded historical reference imagery',()=>{
  const h=harness();h.seed(h.viewer,{id:'a',lat:39,lon:-77},snapshots);h.setGround(2025);h.finishFade();
  h.setGround(2090);assert.equal(h.providers.length,1);assert.match(h.caption.textContent,/not imagery from the selected year/);
  assert.equal(h.layers[0].saturation,undefined);assert.equal(h.layers[0].hue,undefined);
  h.seed(h.viewer,{id:'b',lat:45,lon:-121},snapshots);h.setGround(2025);h.finishFade();
  assert.equal(h.providers.length,2);assert.deepEqual(h.providers[1].rectangle,[-121.2,44.85,-120.8,45.15]);
  assert.equal(h.layers.length,1,'old source windows are released after the handoff');
  h.clearGround();assert.equal(h.layers.length,0);
  h.seed(h.viewer,{id:'missing',lat:40,lon:-90},snapshots);h.setGround(2025);
  assert.equal(h.layers.length,0);assert.match(h.caption.textContent,/no HLS snapshot/);
});
