// Colour-class midpoint estimates from NASA rendered GIBS products. No invented
// sub-pixel variation; missing/unknown colours remain transparent.
export const MAP_SCALES = Object.freeze({
  LST_Day:{min:5,max:45,delta:8,unit:'°C',resolution:'~1 km'},
  LST_Night:{min:0,max:30,delta:6,unit:'°C',resolution:'~1 km'},
  NDVI:{min:0,max:1,delta:.3,unit:'NDVI',resolution:'~250 m'},
  NO2:{min:0,max:12,delta:5,unit:'×10¹⁵ molecules/cm²',resolution:'~5 km'},
  NO2_OMI:{min:0,max:10,delta:4,unit:'×10¹⁵ molecules/cm²',resolution:'~13 × 24 km'},
  AOD:{min:0,max:.8,delta:.3,unit:'AOD',resolution:'~3 km'},
  AirTemp:{min:-10,max:35,delta:4,unit:'°C',resolution:'~50 km'},
});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function evidenceColor(value,scale,change=false,vegetation=false){
  if(!Number.isFinite(value))return [0,0,0,0];
  let t=change?clamp(value/scale.delta,-1,1):clamp((value-scale.min)/(scale.max-scale.min),0,1)*2-1;
  if(vegetation)t=-t;
  const neutral=[229,229,217],cool=[52,144,190],warm=[218,78,48],end=t<0?cool:warm,w=Math.abs(t);
  return [...neutral.map((c,i)=>Math.round(c+(end[i]-c)*w)),Math.round(change?55+180*w:200)];
}
export function recolorEvidence(current,baseline,lut,{scale,offset=0,factor=1,change=false,vegetation=false}={}){
  const output=new Uint8ClampedArray(current.length);
  for(let i=0;i<current.length;i+=4){
    if(!current[i+3]||(change&&(!baseline||!baseline[i+3])))continue;
    const v=lut.get((current[i]<<16)|(current[i+1]<<8)|current[i+2]);
    const b=change?lut.get((baseline[i]<<16)|(baseline[i+1]<<8)|baseline[i+2]):0;
    if(v===undefined||(change&&b===undefined))continue;
    const value=change?(v-b)*factor:(v+offset)*factor;
    output.set(evidenceColor(value,scale,change,vegetation),i);
  }
  return output;
}
const images=new Map();
function imagePixels(url){
  if(images.has(url))return images.get(url);
  const task=new Promise((resolve,reject)=>{
    const image=new Image();image.crossOrigin='anonymous';
    image.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);resolve({width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data});}catch(error){reject(error);}};
    image.onerror=()=>reject(new Error('NASA map tile unavailable'));image.src=url;
  });
  images.set(url,task);task.catch(()=>images.delete(url));
  while(images.size>96)images.delete(images.keys().next().value);
  return task;
}
export function createEvidenceProvider(C,{url,baselineUrl,lut,variable,offset=0,factor=1,change=false,maximumLevel,onError}){
  const provider=new C.UrlTemplateImageryProvider({url,maximumLevel,credit:'NASA GIBS · rendered colour-class midpoint estimates',enablePickFeatures:false});
  const original=provider.requestImage.bind(provider);
  provider.requestImage=function(x,y,z,request){
    const pending=original(x,y,z,request);if(!pending)return undefined;
    return Promise.resolve(pending).then(async image=>{
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
      const current=ctx.getImageData(0,0,canvas.width,canvas.height);
      let baseline;
      if(change){try{baseline=await imagePixels(baselineUrl.replace('{z}',z).replace('{x}',x).replace('{y}',y));}catch{onError?.();return document.createElement('canvas');}}
      current.data.set(recolorEvidence(current.data,baseline?.data,lut,{scale:MAP_SCALES[variable],offset,factor,change,vegetation:variable==='NDVI'}));
      ctx.putImageData(current,0,0);return canvas;
    });
  };
  return provider;
}
export function comparisonDates(variable,year=2025,baselineYear=2005,lastYear=new Date().getUTCFullYear()){
  const first=variable==='NO2'?2023:variable==='NO2_OMI'?2005:2003;
  const selected=Math.max(first,Math.min(lastYear,Math.round(year)));
  return {current:`${selected}-07-15`,baseline:`${Math.max(first,Math.min(selected,baselineYear))}-07-15`,historical:year<=lastYear};
}
function mercatorPixel(lon,lat,z){const n=256*2**z,s=Math.sin(lat*Math.PI/180);return [(lon+180)/360*n,(.5-Math.log((1+s)/(1-s))/(4*Math.PI))*n];}
/** A small geographic raster for the 3D ground material, retaining source cells.
 * Rows are south→north for shader texture coordinates; no bilinear upsampling.
 */
export async function evidenceTexture({center,url,baselineUrl,lut,variable,offset=0,factor=1,change=false,maximumLevel}){
  if(!Number.isFinite(center?.lat)||!Number.isFinite(center?.lon)||Math.abs(center.lat)>85.05)return {active:false,validPixelCount:0};
  const bounds=[center.lon-.35,Math.max(-85.05,center.lat-.35),center.lon+.35,Math.min(85.05,center.lat+.35)],width=256,height=256,z=maximumLevel;
  const plan=[],tiles=new Map(),size=256*2**z;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const lon=bounds[0]+(x+.5)/width*(bounds[2]-bounds[0]),lat=bounds[1]+(y+.5)/height*(bounds[3]-bounds[1]);
    const [gx,gy]=mercatorPixel(lon,lat,z),px=((Math.floor(gx)%size)+size)%size,py=Math.floor(gy),tx=Math.floor(px/256),ty=Math.floor(py/256),key=tx+','+ty;
    if(!tiles.has(key))tiles.set(key,{x:tx,y:ty});
    plan.push([key,((py%256+256)%256*256+px%256)*4]);
  }
  await Promise.all([...tiles.values()].map(async tile=>{const expand=template=>template.replace('{z}',z).replace('{x}',tile.x).replace('{y}',tile.y);try{const [a,b]=await Promise.all([imagePixels(expand(url)),change?imagePixels(expand(baselineUrl)):null]);tile.pixels=recolorEvidence(a.data,b?.data,lut,{scale:MAP_SCALES[variable],offset,factor,change,vegetation:variable==='NDVI'});}catch{tile.pixels=null;}}));
  const rgba=new Uint8Array(width*height*4);for(let i=0;i<plan.length;i++){const [key,offset]=plan[i],pixels=tiles.get(key).pixels;if(pixels)rgba.set(pixels.subarray(offset,offset+4),i*4);}
  let validPixelCount=0;for(let i=3;i<rgba.length;i+=4)if(rgba[i])validPixelCount++;
  return {rgba,width,height,bounds,active:validPixelCount>0,validPixelCount,kind:variable};
}
