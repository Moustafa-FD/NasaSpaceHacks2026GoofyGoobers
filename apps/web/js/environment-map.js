// Spatial products only. A point time series is never interpolated into a map.
import {evidenceColor} from './evidence-map.js';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function powerGridRaster(result){
  const g=result?.grid,lats=g?.latitudes,lons=g?.longitudes;
  if(!Array.isArray(lats)||!Array.isArray(lons)||lats.length<2||lons.length<2||lats.length*lons.length>300000||g.values?.length!==lats.length*lons.length||![...lats,...lons].every(finite))return null;
  if(lats.some((v,i)=>i&&v<=lats[i-1])||lons.some((v,i)=>i&&v<=lons[i-1]))return null;
  const ranges={T2M:{min:-10,max:35},PRECTOTCORR:{min:0,max:10},RH2M:{min:0,max:100},WS2M:{min:0,max:10}};
  const scale=ranges[g.variable];if(!scale)return null;
  const rgba=new Uint8Array(g.values.length*4);let validPixelCount=0;
  for(let i=0;i<g.values.length;i++){const value=g.values[i];if(!finite(value))continue;rgba.set(evidenceColor(value,scale),i*4);validPixelCount++;}
  const dx=(lons[1]-lons[0])/2,dy=(lats[1]-lats[0])/2;
  return {rgba,width:lons.length,height:lats.length,bounds:[Math.max(-180,lons[0]-dx),Math.max(-90,lats[0]-dy),Math.min(180,lons.at(-1)+dx),Math.min(90,lats.at(-1)+dy)],active:validPixelCount>0,kind:'weather',note:`NASA POWER native grid · ${g.variable} · ${g.date} · ${scale.min} to ${scale.max} ${g.units} · blue lower, red higher · missing cells transparent · regional model data, not facility effects`};
}
export function plumeRaster(result){
  const {grid,site}=result||{};
  if(!grid||!Number.isInteger(grid.n)||grid.n<2||grid.n>256||!finite(site?.lat)||!finite(site?.lon)||!finite(grid.halfWidthM))return null;
  const values=grid.values?.flat();if(values?.length!==grid.n*grid.n)return null;
  const valid=values.filter(v=>finite(v)&&v>0),peak=Math.max(...valid);
  if(!valid.length||!finite(peak))return null;
  // Fixed five-decade span relative to this product's maximum, explicitly relative.
  const rgba=new Uint8Array(grid.n*grid.n*4);
  for(let i=0;i<values.length;i++){
    const v=values[i];if(!finite(v)||v<=0)continue;
    const t=Math.max(0,Math.min(1,(Math.log10(v/peak)+5)/5));if(t<=0)continue;
    const row=Math.floor(i/grid.n),col=i%grid.n,j=((grid.n-1-row)*grid.n+col)*4;
    rgba.set([Math.round(70+175*t),Math.round(160-85*t),Math.round(200-150*t),Math.round(35+180*t)],j);
  }
  const dy=grid.halfWidthM/111320,dx=dy/Math.cos(site.lat*Math.PI/180);
  return {rgba,width:grid.n,height:grid.n,bounds:[site.lon-dx,site.lat-dy,site.lon+dx,site.lat+dy],active:true,kind:'plume',note:'Relative dilution · five log decades below maximum · screening scenario, assumed stack height · not measured air quality'};
}
export function attachEnvironmentMap(viewer,{sites=[]}={}){
  const C=Cesium,products=new Map();let plumeEntity=null,stations=[],selected=window.CloudShadow?.state.site?.id,mapGeneration=0;
  const note=document.createElement('aside');note.id='environmentMapNote';note.className='environment-map-note';note.hidden=true;note.setAttribute('role','status');document.body.append(note);
  function clear(){mapGeneration++;if(plumeEntity)viewer.entities.remove(plumeEntity);plumeEntity=null;stations.forEach(s=>viewer.entities.remove(s));stations=[];note.hidden=true;window.dispatchEvent(new CustomEvent('cs:evidence-texture',{detail:{active:false}}));}
  function showPlume(result,weather=false,rasterOverride=null){
    clear();const raster=rasterOverride||(weather?powerGridRaster(result):plumeRaster(result));if(!raster){note.textContent='No valid spatial grid available.';note.hidden=false;return;}
    const canvas=document.createElement('canvas');canvas.width=raster.width;canvas.height=raster.height;
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(raster.width,raster.height);
    // Canvas top is north, typed shader texture bottom is south.
    for(let y=0;y<raster.height;y++)pixels.data.set(raster.rgba.subarray(y*raster.width*4,(y+1)*raster.width*4),(raster.height-y-1)*raster.width*4);
    ctx.putImageData(pixels,0,0);
    plumeEntity=viewer.entities.add({id:'environment-spatial-map',rectangle:{coordinates:C.Rectangle.fromDegrees(...raster.bounds),material:new C.ImageMaterialProperty({image:canvas,transparent:true})}});
    note.textContent=raster.note;note.hidden=false;window.dispatchEvent(new CustomEvent('cs:evidence-texture',{detail:raster}));
    for(const receptor of result.receptors||[]){if(!finite(receptor.lat)||!finite(receptor.lon))continue;stations.push(viewer.entities.add({position:C.Cartesian3.fromDegrees(receptor.lon,receptor.lat),point:{pixelSize:7,color:C.Color.WHITE,outlineColor:C.Color.BLACK,outlineWidth:2,heightReference:C.HeightReference.CLAMP_TO_GROUND,disableDepthTestDistance:Infinity},label:{text:receptor.name+' · screening receptor',font:'11px sans-serif',pixelOffset:new C.Cartesian2(0,-16),showBackground:true,disableDepthTestDistance:Infinity}}));}
    viewer.scene.requestRender();
  }
  function showStations(result,provided){
    clear();const station=result?.station,loc=station?.location;
    const count=result?.coverage?.recordCount??result?.records?.length??0;
    const list=provided?.length?provided:loc?[{lat:loc.latitude,lon:loc.longitude,name:station.name,id:station.id}]:[];
    for(const s of list){const lat=s.lat??s.latitude,lon=s.lon??s.longitude;if(!finite(lat)||!finite(lon))continue;stations.push(viewer.entities.add({id:'environment-water-'+(s.id||stations.length),position:C.Cartesian3.fromDegrees(lon,lat),point:{pixelSize:11,color:C.Color.fromCssColorString('#60cbe3'),outlineColor:C.Color.BLACK,outlineWidth:2,heightReference:C.HeightReference.CLAMP_TO_GROUND,disableDepthTestDistance:Infinity},label:{text:(s.name||s.id||'Water monitoring location')+' · '+count+' returned records',font:'12px sans-serif',pixelOffset:new C.Cartesian2(0,-18),showBackground:true,disableDepthTestDistance:Infinity}}));}
    note.textContent=stations.length?`Water monitoring location · ${count} returned records (may include censored/missing values). No downstream transport or waterway-shape prediction is available.`:'No station coverage in the selected area. Missing coverage is not clean water.';note.hidden=false;
    if(stations.length)viewer.flyTo(stations,{duration:1.5});
  }
  window.addEventListener('cs:environment-data',({detail:d})=>{if(d?.result){const key=d.siteId+':'+d.kind;products.delete(key);products.set(key,d);while(products.size>20)products.delete(products.keys().next().value);}});
  window.addEventListener('cs:environment-layer',({detail:d})=>{
    if(!d?.enabled||d.layer==='off')return clear();
    // Environmental and satellite overlays are mutually exclusive.
    window.CloudShadow?.setMapLayer('none');
    const data=products.get((d.siteId||selected)+':'+(d.layer==='plume'?'plume-scenario':d.layer==='weather'?'grid':'water-quality'));
    const result=d.result||data?.result;
    if(d.layer==='plume')showPlume(result);else if(d.layer==='screening')showPlume(result,false,d.raster);else if(d.layer==='weather')showPlume(result,true);else if(d.layer==='water')showStations(result,data?.stations);
  });
  window.addEventListener('cs:site',({detail})=>{selected=detail?.site?.id;clear();});
  window.addEventListener('cs:location',({detail})=>{selected=detail?.site?.id;clear();});
  window.addEventListener('cs:map-layer',({detail})=>{if(detail?.kind!=='none'&&(plumeEntity||stations.length))clear();});
  return {clear};
}
