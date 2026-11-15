// Colour-class midpoint estimates from NASA rendered GIBS products. No invented
// sub-pixel variation; missing/unknown colours remain transparent.
export const MAP_SCALES = Object.freeze({
  LST_Day:{min:5,max:45,delta:8,unit:'°C',resolution:'~1 km'},
  LST_Night:{min:0,max:30,delta:3,unit:'°C',resolution:'~1 km'},
  NDVI:{min:0,max:1,delta:.3,unit:'NDVI',resolution:'~250 m'},
  NO2:{min:0,max:12,delta:5,unit:'×10¹⁵ molecules/cm²',resolution:'~5 km'},
  NO2_OMI:{min:0,max:10,delta:4,unit:'×10¹⁵ molecules/cm²',resolution:'~13 × 24 km'},
  AOD:{min:0,max:.8,delta:.3,unit:'AOD',resolution:'~3 km'},
  AirTemp:{min:-10,max:35,delta:4,unit:'°C',resolution:'~50 km'},
  SoilMoisture:{min:0,max:50,delta:8,unit:'kg/m²',resolution:'~25 km'},
});
/** Layers where higher is 'more' of something good (greener, wetter): blue = more. */
export const INVERTED_SCALE=new Set(['NDVI','SoilMoisture']);
/** Colour range for 'projected change since the latest real map' (2027-2035): sized to
 * nine years of the observed per-pixel trends, so a real but small trend is visible. */
export const PROJECTED_DELTAS=Object.freeze({LST_Day:1.5,LST_Night:1.5,NDVI:.15,AOD:.06,NO2_OMI:.6,SoilMoisture:4});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const NEUTRAL=[229,229,217],COOL=[52,144,190],RED=[204,32,46],VEG_WARM=[218,78,48];
/** Blue (low) to red (high); vegetation keeps blue = greener, orange = less green. */
export function evidenceColor(value,scale,change=false,vegetation=false){
  if(!Number.isFinite(value))return [0,0,0,0];
  const out=new Uint8ClampedArray(4);colorInto(out,0,value,scale,change,vegetation);return [...out];
}
function colorInto(out,i,value,scale,change,vegetation){
  let t=change?clamp(value/scale.delta,-1,1):clamp((value-scale.min)/(scale.max-scale.min),0,1)*2-1;
  if(vegetation)t=-t;
  const end=t<0?COOL:vegetation?VEG_WARM:RED,w=Math.abs(t);
  out[i]=NEUTRAL[0]+(end[0]-NEUTRAL[0])*w+.5;out[i+1]=NEUTRAL[1]+(end[1]-NEUTRAL[1])*w+.5;out[i+2]=NEUTRAL[2]+(end[2]-NEUTRAL[2])*w+.5;out[i+3]=change?55+180*w+.5:200;
}
const lutRanges=new WeakMap();
function lutRange(lut){
  if(!lutRanges.has(lut)){let lo=Infinity,hi=-Infinity;for(const v of lut.values()){if(v<lo)lo=v;if(v>hi)hi=v;}lutRanges.set(lut,[lo,hi]);}
  return lutRanges.get(lut);
}
/** Decode a trend-map/1.0 product (scripts/trend_maps.py): per-pixel Sen's slope in raw
 * colormap units per year on the native GIBS pixel grid; 0 = no significant trend. */
export function decodeTrendMap(raw){
  if(raw?.schemaVersion!=='trend-map/1.0'||![raw.z,raw.gx0,raw.gy0,raw.width,raw.height,raw.slopeScale].every(Number.isFinite))throw new Error('Unsupported trend map');
  const bytes=Uint8Array.from(atob(raw.slope),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),n=raw.width*raw.height;
  if(bytes.length!==n*2)throw new Error('Trend map size mismatch');
  const slope=new Float32Array(n);for(let i=0;i<n;i++)slope[i]=view.getInt16(i*2,true)*raw.slopeScale;
  return {...raw,slope};
}
/** Per-pixel raw-unit change for one tile: slope x years, mapped from tile (x,y,z) onto the
 * native trend grid. Returns null when the tile does not touch the grid. */
const slopeTiles=new WeakMap();
/** Per-tile slope raster (raw units/yr for each of the 256x256 pixels), built once per
 * trend map and tile and reused for every projected year. null = tile misses the grid. */
export function tileSlopes(t,x,y,z){
  if(!t||z>t.z)return null;
  const k=2**(t.z-z),x0=x*256*k,y0=y*256*k,size=256*k;
  if(x0+size<=t.gx0||x0>=t.gx0+t.width||y0+size<=t.gy0||y0>=t.gy0+t.height)return null;
  let byTile=slopeTiles.get(t);if(!byTile){byTile=new Map();slopeTiles.set(t,byTile);}
  const key=`${z}/${x}/${y}`;if(byTile.has(key))return byTile.get(key);
  const out=new Float32Array(65536),cols=new Int32Array(256);
  for(let px=0;px<256;px++)cols[px]=Math.floor((x*256+px+.5)*k)-t.gx0;
  for(let py=0;py<256;py++){
    const gy=Math.floor((y*256+py+.5)*k)-t.gy0;if(gy<0||gy>=t.height)continue;
    const row=gy*t.width;for(let px=0;px<256;px++){const gx=cols[px];if(gx>=0&&gx<t.width)out[py*256+px]=t.slope[row+gx];}
  }
  byTile.set(key,out);while(byTile.size>64)byTile.delete(byTile.keys().next().value);
  return out;
}
export function tileProjection(projection,x,y,z){
  const years=projection?.years;
  if(!Number.isFinite(years)||years<=0)return null;
  const slopes=tileSlopes(projection?.trend,x,y,z);
  return slopes?pixel=>slopes[pixel]*years:null;
}
const decodedTiles=new WeakMap();
/** Raw colormap values for one decoded tile (NaN = no data), cached per pixel buffer and LUT. */
function tileValues(data,lut){
  let byLut=decodedTiles.get(data);if(!byLut){byLut=new WeakMap();decodedTiles.set(data,byLut);}
  if(byLut.has(lut))return byLut.get(lut);
  const out=new Float32Array(data.length/4);
  for(let p=0,i=0;p<out.length;p++,i+=4){const v=data[i+3]?lut.get((data[i]<<16)|(data[i+1]<<8)|data[i+2]):undefined;out[p]=v===undefined?NaN:v;}
  byLut.set(lut,out);return out;
}
export function recolorEvidence(current,baseline,lut,{scale,offset=0,factor=1,change=false,vegetation=false,adjust=null,slopes=null,years=0,delta=null,cache=false}={}){
  const projected=(slopes&&years>0)||adjust,range=projected?lutRange(lut):null,use=delta?{...scale,delta}:scale;
  const output=new Uint8ClampedArray(current.length);
  if(change&&!baseline)return output;
  // Cached decoding for tiles that are re-coloured every year (projected base maps, baselines).
  const cv=cache?tileValues(current,lut):null,bv=cache&&change?tileValues(baseline,lut):null;
  for(let p=0,i=0;i<current.length;p++,i+=4){
    let v,b=0;
    if(cv){v=cv[p];if(v!==v)continue;}else{if(!current[i+3])continue;v=lut.get((current[i]<<16)|(current[i+1]<<8)|current[i+2]);if(v===undefined)continue;}
    if(change){if(bv){b=bv[p];if(b!==b)continue;}else{if(!baseline[i+3])continue;b=lut.get((baseline[i]<<16)|(baseline[i+1]<<8)|baseline[i+2]);if(b===undefined)continue;}}
    // Projected years: latest real pixel + its own significant trend, kept on the colour scale.
    if(slopes&&years>0)v=Math.max(range[0],Math.min(range[1],v+slopes[p]*years));
    else if(adjust)v=Math.max(range[0],Math.min(range[1],v+adjust(p)));
    colorInto(output,i,change?(v-b)*factor:(v+offset)*factor,use,change,vegetation);
  }
  return output;
}
const images=new Map();
function imagePixels(url){
  if(images.has(url))return images.get(url);
  const task=new Promise((resolve,reject)=>{
    const image=new Image();image.crossOrigin='anonymous';
    const cleanup=()=>{clearTimeout(timer);image.onload=image.onerror=null;};
    const timer=setTimeout(()=>{cleanup();image.src='';reject(new Error('NASA map tile timed out'));},9000);
    image.onload=()=>{cleanup();try{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);resolve({width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data});}catch(error){reject(error);}};
    image.onerror=()=>{cleanup();reject(new Error('NASA map tile unavailable'));};image.src=url;
  });
  images.set(url,task);task.catch(()=>images.delete(url));
  while(images.size>96)images.delete(images.keys().next().value);
  return task;
}
export function createEvidenceProvider(C,{url,baselineUrl,lut,variable,offset=0,factor=1,change=false,maximumLevel,onError,projection=null,delta=null}){
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
      const slopes=projection?tileSlopes(projection.trend,x,y,z):null;
      // Projected tiles reuse one cached decode of the base map for every year.
      const cached=slopes?(await imagePixels(url.replace('{z}',z).replace('{x}',x).replace('{y}',y)).catch(()=>null))?.data:null;
      current.data.set(recolorEvidence(cached||current.data,baseline?.data,lut,{scale:MAP_SCALES[variable],offset,factor,change,vegetation:INVERTED_SCALE.has(variable),slopes,years:projection?.years||0,delta,cache:!!cached}));
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
const plans=new Map();
function texturePlan(bounds,width,height,z){
  const key=`${bounds.join(',')}|${z}`;if(plans.has(key))return plans.get(key);
  const tiles=[],index=new Map(),tileOf=new Uint16Array(width*height),offsets=new Int32Array(width*height),size=256*2**z;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const lon=bounds[0]+(x+.5)/width*(bounds[2]-bounds[0]),lat=bounds[1]+(y+.5)/height*(bounds[3]-bounds[1]);
    const [gx,gy]=mercatorPixel(lon,lat,z),px=((Math.floor(gx)%size)+size)%size,py=Math.floor(gy),tx=Math.floor(px/256),ty=Math.floor(py/256),k=tx+','+ty;
    if(!index.has(k)){index.set(k,tiles.length);tiles.push({x:tx,y:ty});}
    const i=y*width+x;tileOf[i]=index.get(k);offsets[i]=((py%256+256)%256*256+px%256)*4;
  }
  const plan={tiles,tileOf,offsets};plans.set(key,plan);while(plans.size>8)plans.delete(plans.keys().next().value);
  return plan;
}
export async function evidenceTexture({center,url,baselineUrl,lut,variable,offset=0,factor=1,change=false,maximumLevel,projection=null,delta=null}){
  if(!Number.isFinite(center?.lat)||!Number.isFinite(center?.lon)||Math.abs(center.lat)>85.05)return {active:false,validPixelCount:0};
  const bounds=[center.lon-.35,Math.max(-85.05,center.lat-.35),center.lon+.35,Math.min(85.05,center.lat+.35)],width=256,height=256,z=maximumLevel;
  const plan=texturePlan(bounds,width,height,z),tiles=plan.tiles.map(tile=>({...tile,pixels:null}));
  await Promise.all(tiles.map(async tile=>{const expand=template=>template.replace('{z}',z).replace('{x}',tile.x).replace('{y}',tile.y);try{const [a,b]=await Promise.all([imagePixels(expand(url)),change?imagePixels(expand(baselineUrl)):null]);tile.pixels=recolorEvidence(a.data,b?.data,lut,{scale:MAP_SCALES[variable],offset,factor,change,vegetation:INVERTED_SCALE.has(variable),slopes:projection?tileSlopes(projection.trend,tile.x,tile.y,z):null,years:projection?.years||0,delta,cache:true});}catch{tile.pixels=null;}}));
  const loadedTileCount=tiles.filter(tile=>tile.pixels!==null).length,failedTileCount=tiles.length-loadedTileCount;
  if(!loadedTileCount)throw new Error('NASA source tiles could not be loaded');
  const rgba=new Uint8Array(width*height*4);for(let i=0;i<plan.offsets.length;i++){const pixels=tiles[plan.tileOf[i]].pixels;if(pixels){const o=plan.offsets[i],j=i*4;rgba[j]=pixels[o];rgba[j+1]=pixels[o+1];rgba[j+2]=pixels[o+2];rgba[j+3]=pixels[o+3];}}
  let validPixelCount=0;for(let i=3;i<rgba.length;i+=4)if(rgba[i])validPixelCount++;
  const wrap=lon=>((lon+180)%360+360)%360-180;
  return {rgba,width,height,bounds:[wrap(bounds[0]),bounds[1],wrap(bounds[2]),bounds[3]],active:validPixelCount>0,validPixelCount,loadedTileCount,failedTileCount,kind:variable};
}
