// Artistic weather wisps. Satellite NO2 and surface heat are not visible-smoke
// measurements; neither sets a fire color or a particle-density estimate.
import { emissionPolicy } from './campus-effects.js';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
const fract=(v)=>v-Math.floor(v);
function noise(x,y){
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const hash=(a,b)=>fract(Math.sin(a*127.1+b*311.7)*43758.5453);
  const u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy),a=hash(ix,iy),b=hash(ix+1,iy),c=hash(ix,iy+1),d=hash(ix+1,iy+1);
  return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
}

export function globeSmokePolicy(site,year,row={},phase='observed') {
  const source=emissionPolicy(site,year,row,phase);
  const rain=row.PrecipMMDay==null||row.PrecipMMDay===''?null:Number(row.PrecipMMDay);
  return {
    eligible:source.eligible,
    particleRate:source.eligible?(phase==='projected'?6:8):0,
    fluidPollution:source.eligible?0.35:0,
    // Heat stays in the numerical HUD and trend strip, never a smoke source.
    heat:0,
    moisture:Number.isFinite(rain)&&rain>=0?clamp(rain/30,0,0.12):0,
    windTowardDeg:source.windTowardDeg,windSpeedMs:source.windSpeedMs,
    illustrative:true,
  };
}

export function plumeParticleAlpha(age,life) {
  if(!Number.isFinite(age)||!Number.isFinite(life)||life<=0)return 0;
  const t=clamp(age/life,0,1);
  return 0.16*smooth(0,0.15,t)*(1-smooth(0.3,1,t));
}

/** Original soft, eroded sprite with holes; no downloaded textures or solid discs. */
export function smokeSpriteRgba(size=64) {
  const pixels=new Uint8ClampedArray(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=(x+.5)/size*2-1,v=(y+.5)/size*2-1;
    const outline=1-smooth(.24,1,Math.sqrt(u*u+v*v));
    const erosion=smooth(.28,.72,.62*noise(u*4+7,v*4+3)+.38*noise(u*10+11,v*10+17));
    const k=(x+y*size)*4;
    pixels[k]=pixels[k+1]=pixels[k+2]=255;
    pixels[k+3]=Math.round(outline*erosion*190);
  }
  return pixels;
}

export function createSmokeSprite(size=64) {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  const context=canvas.getContext('2d'),image=context.createImageData(size,size);
  image.data.set(smokeSpriteRgba(size));context.putImageData(image,0,0);return canvas;
}

/** CPU counterpart of the GPU dye display. RGBA are normalized, opacity <= .19.
 * UV +Y is north. `out` lets the CPU fallback reuse one array for every pixel.
 */
export function weatherDyePixel(heat,pollution,moisture,u,v,time,windE,windN,projected=false,out=[0,0,0,0]) {
  const p=clamp(pollution||0,0,1.6),m=clamp(moisture||0,0,1.6),speed=Math.hypot(windE,windN);
  const wx=speed>.001?windE/speed:0,wy=speed>.001?windN/speed:1;
  const x=u-.5,y=v-.5,along=x*wx+y*wy,across=x*-wy+y*wx;
  const width=.025+Math.max(0,along)*.25;
  const corridor=speed>.001?Math.exp(-across*across/(width*width))*smooth(-.07,.015,along)*(1-smooth(.15,.48,along)):Math.exp(-(x*x+y*y)/.0064);
  const erosion=smooth(.28,.72,.65*noise(u*23-time*.04*wx,v*23-time*.04*wy)+.35*noise(u*49+5-time*.08*wx,v*49+5-time*.08*wy));
  const edge=smooth(0,.09,Math.min(u,v,1-u,1-v));
  const smoke=p*corridor,total=Math.max(smoke+m*.35,.00001);
  const shade=.9+erosion*.1;
  // Same violet palette as the GPU shader (dense core -> light lilac edge).
  const k=clamp(smoke*.6,0,1),pr=.55+(.86-.55)*k,pg=.22+(.66-.22)*k,pb=.95+(1-.95)*k;
  out[0]=(smoke*pr+m*.35*.74)/total*shade;
  out[1]=(smoke*pg+m*.35*.81)/total*shade;
  out[2]=(smoke*pb+m*.35*.86)/total*shade;
  if(projected){out[0]=out[0]*.94;out[2]=Math.min(1,out[2]+.025);}
  out[3]=clamp((1-Math.exp(-(smoke*1.1+m*.12)))*(.55+.45*erosion)*edge,0,.62);
  return out;
}

export const WEATHER_DYE_FRAGMENT_SHADER=`uniform sampler2D dye;
uniform vec2 windDirection;
uniform float visualTime;
uniform float projected;
float wispHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float wispNoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float a=wispHash(i),b=wispHash(i+vec2(1,0)),c=wispHash(i+vec2(0,1)),d=wispHash(i+vec2(1,1));return a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y;}
void main(){
  vec3 d=max(texture(dye,vUv).xyz,0.0);
  float p=min(d.y,1.6),m=min(d.z,1.6),speed=length(windDirection);
  vec2 wind=speed>0.001?windDirection/speed:vec2(0,1),center=vUv-0.5;
  float along=dot(center,wind),across=dot(center,vec2(-wind.y,wind.x)),width=0.025+max(0.0,along)*0.25;
  float corridor=speed>0.001?exp(-across*across/(width*width))*smoothstep(-0.07,0.015,along)*(1.0-smoothstep(0.15,0.48,along)):exp(-dot(center,center)/0.0064);
  float erosion=smoothstep(0.28,0.72,0.65*wispNoise(vUv*23.0-visualTime*0.04*wind)+0.35*wispNoise(vUv*49.0+5.0-visualTime*0.08*wind));
  float edge=smoothstep(0.0,0.09,min(min(vUv.x,vUv.y),min(1.0-vUv.x,1.0-vUv.y)));
  float smoke=p*corridor,total=max(smoke+m*0.35,0.00001);
  // Violet reads clearly over green/brown satellite ground (orange/grey did not).
  vec3 color=(smoke*mix(vec3(0.55,0.22,0.95),vec3(0.86,0.66,1.0),clamp(smoke*0.6,0.0,1.0))+m*0.35*vec3(0.74,0.81,0.86))/total*(0.9+erosion*0.1);
  if(projected>0.5){color.r*=0.94;color.b=min(1.0,color.b+0.025);}
  float alpha=clamp((1.0-exp(-(smoke*1.1+m*0.12)))*(0.55+0.45*erosion)*edge,0.0,0.62);
  o=vec4(color,alpha);
}`;
