import test from 'node:test';
import assert from 'node:assert/strict';
import { globeSmokePolicy, plumeParticleAlpha, smokeSpriteRgba, weatherDyePixel } from '../apps/web/js/smoke-policy.js';

const source={onset:'2024-06',effects:{plume:true}};
test('globe wisps require documented combustion and never equate satellite heat/NO2 with smoke density',()=>{
  for(const site of [{}, {onset:'2024-06',effects:{plume:false}}, {effects:{plume:true}}]){
    const policy=globeSmokePolicy(site,2025,{NO2_Local:1000,LST_Night_Local:100});
    assert.equal(policy.particleRate,0);assert.equal(policy.fluidPollution,0);assert.equal(policy.heat,0);
  }
  assert.equal(globeSmokePolicy(source,2023).particleRate,0);
  const clean=globeSmokePolicy(source,2025,{NO2_Local:0,LST_Night_Local:0});
  const high=globeSmokePolicy(source,2025,{NO2_Local:1e9,LST_Night_Local:100});
  assert.deepEqual(clean,high,'artistic opacity is not a visible-emissions estimate');
  assert.equal(high.particleRate,8);
  assert.ok(high.particleRate*14<=112,'the maximum particle lifetime has a bounded pool');
  assert.equal(high.illustrative,true);
  assert.equal(globeSmokePolicy(source,2030,{},'projected').particleRate,6);
  assert.equal(clean.windTowardDeg,null);assert.equal(clean.windSpeedMs,0);
});

test('particle wisps fade in, taper out, and never become opaque puffs',()=>{
  assert.equal(plumeParticleAlpha(0,12),0);
  assert.equal(plumeParticleAlpha(12,12),0);
  assert.equal(plumeParticleAlpha(20,12),0);
  assert.equal(plumeParticleAlpha(NaN,12),0);
  assert.equal(plumeParticleAlpha(1,0),0);
  assert.ok(plumeParticleAlpha(5,12)>plumeParticleAlpha(10,12));
  for(let age=0;age<=12;age+=.1)assert.ok(plumeParticleAlpha(age,12)<=.16);
});

test('original smoke sprite has transparent borders and eroded internal alpha rather than a solid disc',()=>{
  const size=64,pixels=smokeSpriteRgba(size),again=smokeSpriteRgba(size);
  assert.deepEqual(pixels,again);
  let clearInside=0,visibleInside=0,max=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=pixels[(x+y*size)*4+3];max=Math.max(max,a);
    if(x===0||y===0||x===size-1||y===size-1)assert.ok(a<=1);
    if(x>16&&x<48&&y>16&&y<48){if(a<12)clearInside++;if(a>70)visibleInside++;}
  }
  assert.ok(clearInside>10&&visibleInside>10);
  assert.ok(max<=190,'even the densest sprite texel remains translucent');
});

test('CPU/GPU weather-display contract is violet (never orange), translucent and fully transparent at texture borders',()=>{
  for(const projected of [false,true])for(let i=0;i<=50;i++)for(let j=0;j<=50;j++){
    const u=i/50,v=j/50,pixel=weatherDyePixel(999,999,999,u,v,10,0,1,projected);
    assert.ok(pixel.every(Number.isFinite));
    assert.ok(pixel.every((c)=>c>=0&&c<=1));
    assert.ok(pixel[3]<=.62);
    if(pixel[3]>.001)assert.ok(pixel[2]>=pixel[0]&&pixel[2]>pixel[1],'blue-dominant violet palette: no orange/yellow');
    if(i===0||i===50||j===0||j===50)assert.equal(pixel[3],0,'the rectangular texture cannot show an outline');
    assert.equal(weatherDyePixel(999,0,0,u,v,10,0,1)[3],0,'heat alone never produces a visible source');
  }
});

test('source wisps taper downwind and contain transparent gaps instead of a solid plane or ring',()=>{
  let down=0,up=0,center=0,tail=0,gaps=0,visible=0;
  for(let i=1;i<80;i++)for(let j=1;j<80;j++){
    const x=i/80,y=j/80,a=weatherDyePixel(0,1.6,0,x,y,0,0,1)[3];
    if(y>.52)down+=a;if(y<.42)up+=a;
    if(y>.6&&y<.75&&Math.abs(x-.5)<.07)center+=a;
    if(y>.9&&y<.99&&Math.abs(x-.5)<.07)tail+=a;
    if(y>.5&&y<.85&&Math.abs(x-.5)<.1){if(a<.005)gaps++;if(a>.02)visible++;}
  }
  assert.ok(down>up*5);
  assert.ok(center>tail*2);
  assert.ok(gaps>10&&visible>10);
});
