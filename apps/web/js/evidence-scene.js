import {siteAuditWaterReadings} from './site-audit.js';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
export function screeningSpatialRaster(result,year,domain){
  if(!['heat','air'].includes(domain))return null;
  const base=result?.spatial?.dispersion,scaleKey=domain==='heat'?'heatMultiplier':'airMultiplier',scales=result?.spatial?.scales||[],selected=scales.find(row=>row.year===year),multiplier=selected?.[scaleKey],grid=base?.grid;
  if(!finite(multiplier)||multiplier<0||!Number.isInteger(grid?.n)||grid.n<2||grid.n>256||grid.values?.length!==grid.n||!finite(base.site?.lat)||!finite(base.site?.lon)||!finite(grid.halfWidthM))return null;
  const values=grid.values.flat();if(values.length!==grid.n*grid.n)return null;
  const maximum=Math.max(0,...values.filter(finite))*Math.max(0,...scales.map(row=>row[scaleKey]).filter(finite));if(maximum===0)return null;
  const rgba=new Uint8Array(values.length*4);
  for(let index=0;index<values.length;index++){
    const value=values[index];if(!finite(value)||value<0)continue;
    const ratio=Math.min(1,value*multiplier/maximum),row=Math.floor(index/grid.n),col=index%grid.n,offset=((grid.n-1-row)*grid.n+col)*4;
    rgba.set([Math.round(70+180*ratio),Math.round(170-85*ratio),Math.round(200-150*ratio),Math.round(190*Math.sqrt(ratio))],offset);
  }
  const dy=grid.halfWidthM/111320,dx=dy/Math.cos(base.site.lat*Math.PI/180);if(!finite(dx))return null;
  const unit=domain==='heat'?'°C passive-tracer temperature rise':'µg/m³ source contribution';
  return {active:true,rgba,width:grid.n,height:grid.n,bounds:[base.site.lon-dx,base.site.lat-dy,base.site.lon+dx,base.site.lat+dy],kind:'screening',note:`${year} conditional ${domain} screening · 0 to ${maximum.toPrecision(3)} ${unit}. Scale fixed across supplied scenario years. Opacity fades toward zero. Source assumptions and historical NASA winds; no calibrated future weather/chemistry.`};
}
export function noiseContourPlan(result,year){
  return (result?.years?.find(row=>row.year===year)?.noiseContours||[]).filter(row=>finite(row.radiusM)&&row.radiusM>=1&&row.radiusM<=10000&&finite(row.levelDbA)&&row.status==='conditional-screening').slice(0,5);
}
export function attachEvidenceScene(viewer,{eventTarget=window}={}){
  const C=globalThis.Cesium;let state=null,waterEnabled=false,entities=[],rasterKey='',ringKey='';
  const groundHeight=(lon,lat)=>eventTarget.CloudShadowNeighborhood?.groundHeightAt?.(lon,lat)??viewer.scene.globe?.getHeight?.(C.Cartographic.fromDegrees(lon,lat))??0;
  const clear=()=>{entities.forEach(e=>viewer.entities.remove(e));entities=[];};
  function paint(){
    const raw=state?.products?.['environment-screening'],domain=state?.screeningDomain;
    const contours=state?.showScreening&&domain==='noise'?noiseContourPlan(raw,state.year):[];
    const readings=waterEnabled?siteAuditWaterReadings(state?.audit,state?.year).filter(r=>r.available):[];
    const key=JSON.stringify([state?.siteId,state?.year,contours,readings]);
    if(key!==ringKey){
      clear();ringKey=key;
      contours.forEach((item,index)=>entities.push(viewer.entities.add({id:'screening-noise-'+index,position:C.Cartesian3.fromDegrees(state.site.lon,state.site.lat),ellipse:{semiMajorAxis:item.radiusM,semiMinorAxis:item.radiusM,height:groundHeight(state.site.lon,state.site.lat)+6,fill:false,outline:true,outlineColor:C.Color.fromCssColorString('#e2c58b')},description:`${item.levelDbA} dB(A) source-only free-field scenario at ${item.radiusM.toFixed(0)} m. Chosen comparison level, not a health or legal limit.`})));
      readings.slice(0,12).forEach((reading,index)=>entities.push(viewer.entities.add({id:'audited-water-gauge-'+index,position:C.Cartesian3.fromDegrees(reading.lon,reading.lat,groundHeight(reading.lon,reading.lat)+8),point:{pixelSize:10,color:C.Color.fromCssColorString('#7bd3e3'),outlineColor:C.Color.BLACK,outlineWidth:2},label:{text:`${reading.name}\n${reading.year}: ${reading.mean.toFixed(1)} ${reading.unit} · recorded daily means`,font:'14px sans-serif',pixelOffset:new C.Cartesian2(0,-25),showBackground:true,disableDepthTestDistance:0},description:reading.note+' '+reading.sourceUrl})));
      viewer.scene.requestRender();
    }
    const raster=state?.showScreening?screeningSpatialRaster(raw,state.year,domain):null,next=raster?JSON.stringify([state.siteId,state.year,domain,raw.modelVersion,raw.years]):'';
    if(next!==rasterKey){
      if(raster)eventTarget.dispatchEvent(new CustomEvent('cs:environment-layer',{detail:{layer:'screening',enabled:true,siteId:state.siteId,result:raw,raster}}));
      else if(rasterKey)eventTarget.dispatchEvent(new CustomEvent('cs:environment-layer',{detail:{layer:'screening',enabled:false}}));
      rasterKey=next;
    }
  }
  const onState=event=>{state=event.detail?.state;paint();},onWater=event=>{if(event.detail?.siteId!==state?.siteId)return;eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{showScreening:false}}));waterEnabled=event.detail?.enabled!==false;paint();if(waterEnabled&&entities.length)viewer.flyTo?.(entities,{duration:1.2,offset:new C.HeadingPitchRange(0,-Math.PI/3,2000)});},onSite=()=>{waterEnabled=false;clear();ringKey='';},onMap=event=>{if(event.detail?.kind!=='none'&&rasterKey){rasterKey='';eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{showScreening:false}}));}};
  eventTarget.addEventListener('cs:future-state',onState);eventTarget.addEventListener('cs:audit-water-view',onWater);eventTarget.addEventListener('cs:site',onSite);eventTarget.addEventListener('cs:location',onSite);
  eventTarget.addEventListener('cs:map-layer',onMap);
  const onTerrain=()=>{if(waterEnabled||state?.showScreening&&state.screeningDomain==='noise'){ringKey='';paint();}};eventTarget.addEventListener('cs:scene-mode',onTerrain);
  return {setState(value){state=value;paint();},destroy(){eventTarget.removeEventListener('cs:future-state',onState);eventTarget.removeEventListener('cs:audit-water-view',onWater);eventTarget.removeEventListener('cs:site',onSite);eventTarget.removeEventListener('cs:location',onSite);eventTarget.removeEventListener('cs:map-layer',onMap);eventTarget.removeEventListener('cs:scene-mode',onTerrain);clear();if(rasterKey)eventTarget.dispatchEvent(new CustomEvent('cs:environment-layer',{detail:{layer:'screening',enabled:false}}));}};
}
