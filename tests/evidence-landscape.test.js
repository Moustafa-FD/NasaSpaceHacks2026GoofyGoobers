import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceCoordinateFrame,evidenceTextureCoordinate,normalizeEvidenceTexture,setLandscapeEvidence,createLandscapeShader,LANDSCAPE_FRAGMENT_SHADER} from '../apps/web/js/landscape-shader.js';

const center={lat:35,lon:-90},bounds=[-90.02,34.98,-89.98,35.02];
const rgba=new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,0]);
const raster=()=>({active:true,rgba:rgba.slice(),width:2,height:2,bounds:[...bounds]});
function atGeo(origin,lon,lat,extent=bounds){const f=evidenceCoordinateFrame(origin);return evidenceTextureCoordinate(origin,(lon-f[0])/f[2],(lat-f[1])/f[3],extent);}

test('source cells retain south-to-north orientation, west/east order and supplied alpha',()=>{
  const image=normalizeEvidenceTexture(raster());
  for(const [lon,lat,expected] of [[-90.01,34.99,[255,0,0,255]],[-89.99,34.99,[0,255,0,255]],[-90.01,35.01,[0,0,255,255]],[-89.99,35.01,[255,255,0,0]]]){
    const [u,v]=atGeo(center,lon,lat),column=Math.min(image.width-1,Math.floor(u*image.width)),row=Math.min(image.height-1,Math.floor(v*image.height));
    assert.deepEqual([...image.rgba.slice((row*image.width+column)*4,(row*image.width+column+1)*4)],expected);
  }
  assert.equal(atGeo(center,-90.021,35),null);assert.equal(atGeo(center,-90,35.021),null);
  assert.equal(atGeo(center,-89.979,35),null);assert.equal(atGeo(center,-90,34.979),null);
});

test('adjacent streamed patches map the same real position to the same source cell without synthetic spatial detail',()=>{
  const other={lat:35.015,lon:-90.014},a=atGeo(center,-90.003,35.002),b=atGeo(other,-90.003,35.002);
  for(let i=0;i<2;i++)assert.ok(Math.abs(a[i]-b[i])<1e-9);
  const dateline=[179.8,-1,-179.8,1];
  assert.ok(Math.abs(atGeo({lat:0,lon:179.9},-179.9,0,dateline)[0]-.75)<1e-9);
  assert.equal(atGeo({lat:0,lon:179.9},179.7,0,dateline),null);
});

test('evidence payloads are bounded, validated and copied once so invalid data cannot paint the terrain',()=>{
  const input=raster(),image=normalizeEvidenceTexture(input);input.rgba.fill(1);input.bounds[0]=0;
  assert.deepEqual([...image.rgba], [...rgba]);assert.deepEqual(image.bounds,bounds);
  for(const bad of [{active:false},{...raster(),width:2049},{...raster(),width:1},{...raster(),bounds:[0,1,0,0]},{...raster(),bounds:[0,0,0,1]},{...raster(),bounds:[NaN,0,1,1]},{...raster(),rgba:new Float32Array(16)}])assert.equal(normalizeEvidenceTexture(bad),null);
});

class Vector{constructor(...values){this.values=values;}}
class Options{constructor(options){Object.assign(this,options);}setUniform(name,value){this.uniforms[name].value=value;}isDestroyed(){return !!this.dead;}}
const C={Cartesian2:Vector,Cartesian3:Vector,Cartesian4:Vector,CustomShader:Options,TextureUniform:Options,CustomShaderMode:{MODIFY_MATERIAL:1},UniformType:{FLOAT:'float',VEC2:'vec2',VEC3:'vec3',VEC4:'vec4',SAMPLER_2D:'sampler'},VaryingType:{FLOAT:1,VEC2:2},PixelFormat:{RGBA:1},PixelDatatype:{UNSIGNED_BYTE:1},TextureMinificationFilter:{NEAREST:'nearest'},TextureMagnificationFilter:{NEAREST:'nearest'}};

test('new shaders start transparent, accept a real raster, replace it on clear and ignore destroyed assets',()=>{
  const a=createLandscapeShader(C,null,{center}),image=normalizeEvidenceTexture(raster());
  assert.equal(a.uniforms.u_evidenceActive.value,0);assert.equal(a.uniforms.u_evidence.value.width,1);
  setLandscapeEvidence(C,a,image);assert.equal(a.uniforms.u_evidenceActive.value,1);
  assert.equal(a.uniforms.u_evidence.value.typedArray,image.rgba);assert.equal(a.uniforms.u_evidence.value.minificationFilter,'nearest');assert.equal(a.uniforms.u_evidence.value.repeat,false);
  assert.deepEqual(a.uniforms.u_evidenceBounds.value.values,bounds);
  assert.deepEqual(a.uniforms.u_patchGeo.value.values,evidenceCoordinateFrame(center));
  const future=createLandscapeShader(C,null,{center:{lat:35.01,lon:-90.01}});setLandscapeEvidence(C,future,image);assert.equal(future.uniforms.u_evidence.value.typedArray,image.rgba);
  setLandscapeEvidence(C,a,null);assert.equal(a.uniforms.u_evidenceActive.value,0);assert.deepEqual([...a.uniforms.u_evidence.value.typedArray],[0,0,0,0]);
  future.dead=true;assert.doesNotThrow(()=>setLandscapeEvidence(C,future,null));
});

test('evidence color is applied after artistic materials, only to ground/water and inside real coverage',()=>{
  const block=LANDSCAPE_FRAGMENT_SHADER.slice(LANDSCAPE_FRAGMENT_SHADER.indexOf('if (u_evidenceActive'));
  assert.match(block,/kind > 2\.5 && kind < 4\.5/);assert.match(block,/greaterThanEqual\(uv,vec2\(0\.0\)\)/);assert.match(block,/lessThanEqual\(uv,vec2\(1\.0\)\)/);
  assert.match(block,/pow\(evidence\.rgb,vec3\(2\.2\)\),evidence\.a/);
  assert.doesNotMatch(block,/Noise|Hash|sin\(|material\.alpha|positionMC|discard/);
});
