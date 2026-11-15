// Model outputs in the scene retain their actual period, source cell and units.
// A regional point projection is never painted as a detailed impact heat map.
import {summarizeFutureClimate,futureProductMatchesSite} from './future-data.js';
import {POWER_PATHWAYS,powerProjectionYear} from './power-projection.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=(value,digits=1)=>finite(value)?value.toLocaleString('en-US',{maximumFractionDigits:digits}):'Unknown';
const signed=(value,digits=1)=>finite(value)?`${value>0?'+':''}${number(value,digits)}`:'Unknown';
const scenarioName=scenario=>scenario==='ssp585'?'SSP5-8.5 · very high emissions':'SSP2-4.5 · intermediate emissions';
const safePoint=site=>finite(site?.lat)&&finite(site?.lon)&&Math.abs(site.lat)<=90&&Math.abs(site.lon)<=180;
function trendPresentation(state,group,position){
  const variable=group==='vegetation'?'NDVI':'NO2_OMI',trend=state.trend?.variables?.[variable];
  if(!trend?.available||!finite(trend.value)||trend.year!==state.year||state.year>2035)return null;
  const unit=group==='vegetation'?'NDVI':'×10¹⁵ molecules/cm²',title=group==='vegetation'?'Greenness':'NO₂ column';
  return {kind:'trend',group,position,color:'#a8cbc3',title,
    label:`${title} · ${state.year}\n${number(trend.value,3)} ${unit}\nIf the historical trend continues`,
    note:`Trend extension through 2035; not a validated forecast or an isolated facility effect.${finite(trend.min)&&finite(trend.max)?` Slope-based range ${number(trend.min,3)} to ${number(trend.max,3)} ${unit}.`:''}`};
}

/** The footprint is the selected source grid cell, not a facility buffer. */
export function futureClimateBounds(result){
  const point=result?.gridPoints?.find(p=>Array.isArray(p)&&p.length>=2&&finite(p[0])&&finite(p[1])&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180);
  if(!point)return null;
  const [lat,lon]=point;
  // Bundled NEX-GDDP-CMIP6 point products use a 0.25-degree source grid.
  return [Math.max(-180,lon-.125),Math.max(-90,lat-.125),Math.min(180,lon+.125),Math.min(90,lat+.125)];
}

/** Pure display plan: no inferred pollution, crop mortality or waterway loss. */
export function futureScenePresentation(state,{group=state?.group||'heat',currentYear=new Date().getUTCFullYear()}={}){
  if(!safePoint(state?.site)||state.siteId!==state.site.id||!finite(state.year))return null;
  const products=state.products||{},position={lat:state.site.lat,lon:state.site.lon};
  if(state.showScreening){
    const raw=products['environment-screening'],domain=state.screeningDomain||group,row=raw?.years?.find(row=>row.year===state.year),metrics=row?.metrics?.filter(m=>m.domain===domain&&finite(m.value))||[];
    if(metrics.length&&futureProductMatchesSite(raw,state.site))return {kind:'screening',group:domain,position,raw,domain,year:state.year,color:'#dfbf87',title:'Conditional local scenario',label:`${state.year} · ${domain} screening scenario\n${metrics.slice(0,3).map(m=>`${m.label}: ${number(m.value,3)} ${m.unit}`).join('\n')}\n${row.source?.evidence==='assumed'?'Assumed inputs':'Reported inputs'} · uncalibrated screening`,note:(raw.limitations||[]).join(' ')};
    return null;
  }
  if(state.year<=currentYear)return null;
  if(group==='heat'||group==='water'){
    const annual=products['power-projection'];
    if(state.climateView==='annual'&&annual&&futureProductMatchesSite(annual,state.site)){
      const row=powerProjectionYear(annual,{year:state.year,scenario:state.powerScenario||'ssp245'}),water=group==='water',value=water?row.precipitationMm:row.temperatureC,unit=water?'mm/year':'°C';
      if(finite(value))return {kind:'annual-climate',group,position,metric:water?'precipMmPerYear':'meanTempC',value,unit,period:{start:state.year,end:state.year,label:String(state.year)},color:water?'#70bedb':'#f3b47c',title:'NASA annual climate simulation',label:`${state.year} · ${water?'Regional precipitation':'Regional air temperature'}\n${number(value,water?0:1)} ${unit}\n${POWER_PATHWAYS[row.scenario]} · climate simulation`,note:`NASA POWER NEX-GDDP-CMIP6 ensemble, 0.25° regional grid. Complete model year, not a weather forecast or facility effect. No model-spread interval supplied.`};
    }
    const metric=group==='water'?'precipMmPerYear':['meanTempC','hotDays35C'].includes(state.metric)?state.metric:'meanTempC';
    const raw=products['climate-projection'];
    if(raw&&!futureProductMatchesSite(raw,state.site))return null;
    const climate=raw?summarizeFutureClimate(raw,{year:state.year,scenario:state.scenario,metric}):state.climate?.metrics?.[metric]||(state.climate?.metric===metric?state.climate:null);
    const units=metric==='meanTempC'?'°C':metric==='hotDays35C'?'days/year':'mm/year',title=metric==='meanTempC'?'Regional air temperature':metric==='hotDays35C'?'Regional days ≥35°C':'Regional rainfall';
    const daily=state.dailyClimate?.metrics?.[metric],hasDaily=daily?.available&&finite(daily.value)&&daily.year===state.year;
    const dailyText=hasDaily?`${state.year} daily-climate models: ${number(daily.value)} ${units}`:'';
    if(!climate?.available||!finite(climate.value)||!climate.period){
      return hasDaily?{kind:'daily-climate',group,position,metric,value:daily.value,unit:units,period:daily.period,color:group==='water'?'#70bedb':'#f3b47c',title,
        label:`${title} · ${state.year} model year\n${number(daily.value)} ${units}\nDaily climate simulation · not a weather forecast`,
        note:`Complete-year climate model results; ${daily.models} models. Regional simulation, not facility-attributable heat or water impacts.`}:null;
    }
    const change=climate.change?.median;
    return {kind:'climate',group,position,metric,value:climate.value,unit:units,period:climate.period,scenario:state.scenario||'ssp245',bounds:futureClimateBounds(raw),color:group==='water'?'#70bedb':'#f3b47c',
      title,label:`${title} · ${climate.period.label}\n${number(climate.value)} ${units}${finite(change)?`  (${signed(change)} vs baseline)`:''}\n${scenarioName(state.scenario)} · regional scenario${dailyText?'\n'+dailyText:''}`,
      note:`${climate.period.label} period summary · ${climate.source?.name||'NASA NEX-GDDP-CMIP6'} · source grid cell, about 25 km. This is regional climate, not the facility’s added heat or water use.${hasDaily?' The daily-climate annual value is a separate model product, not an interpolation of this period.':''}`};
  }
  if(group==='air'){
    const raw=products['plume-scenario']||state.plume?.result;
    if(!raw?.grid||!safePoint(raw.site)||!futureProductMatchesSite(raw,state.site)||!finite(raw.peak?.chiOverQ))return trendPresentation(state,group,position);
    const concentration=raw.peak.concentrationUgM3,hasEmission=finite(concentration)&&concentration>=0&&finite(raw.emission?.rateGs)&&raw.emission.rateGs>0&&typeof raw.emission?.source==='string'&&raw.emission.source.trim();
    return {kind:'plume',group,position,raw,color:'#dca77f',title:'Air-dispersion screening',
      label:`Conditional air-dispersion screening\n${hasEmission?`${number(concentration,2)} µg/m³ · source-only peak`:`χ/Q ${raw.peak.chiOverQ.toExponential(2)} s/m³ · dilution peak`}\nWind-driven scenario · not a ${state.year} air-quality forecast`,
      note:`${finite(raw.assumptions?.effectiveStackHeightM)?`${number(raw.assumptions.effectiveStackHeightM)} m effective stack height · `:''}${hasEmission?'Source emissions: '+raw.emission.source:'Relative dilution only; no emission rate supplied.'} Historical wind sample; no future atmospheric chemistry or background pollution.`};
  }
  if(group==='vegetation'){
    const raw=products.agriculture||state.agriculture?.result;
    if(!Array.isArray(raw?.comparisons))return trendPresentation(state,group,position);
    const values=raw.comparisons.flatMap(model=>{const item=model.indicators?.heatThresholdDays;return finite(item?.futureMeanPerSeason)?[{model:model.model,value:item.futureMeanPerSeason,change:item.change}]:[];});
    if(!values.length)return trendPresentation(state,group,position);
    const start=raw.futurePeriod?.start,end=raw.futurePeriod?.end;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end||''))return null;
    const period=`${start.slice(0,4)}–${end.slice(0,4)}`,threshold=raw.settings?.heatThresholdC;
    return {kind:'agriculture',group,position,color:'#a7d399',title:'Growing-season climate exposure',period:{start,end,label:period},
      label:`Growing-season climate exposure · ${period}\n${values.map(item=>`${item.model}: ${number(item.value)} hot days/season`).join('\n')}\nConditional model results · not crop loss`,
      note:`${finite(threshold)?`Hot-day threshold ${number(threshold)}°C · `:''}${values.length} climate models. A climate-exposure indicator does not predict forest mortality, crop yield or facility damage.`};
  }
  return null;
}

/** Two retained entities maximum; no animation-clock or per-frame work. */
export function attachFutureScene(viewer,{eventTarget=globalThis.window,document:doc=globalThis.document,site,year=2025}={}){
  const C=globalThis.Cesium;if(!viewer?.entities||!C||!eventTarget)throw new Error('Future scene needs a Cesium viewer and an event target.');
  let state={siteId:site?.id,site,year,group:'heat',products:{}},selectedSiteId=site?.id,pendingState=null,group='heat',disposed=false,label=null,cell=null,ownedPlume=null,presentation=null,visualKey=null;
  const listeners=[],anchors=new Map();
  const on=(name,listener)=>{eventTarget.addEventListener(name,listener);listeners.push([name,listener]);};
  const emit=(type,detail)=>eventTarget.dispatchEvent(new CustomEvent(type,{detail}));
  if(doc?.head&&!doc.getElementById('future-scene-style')){const link=doc.createElement('link');link.id='future-scene-style';link.rel='stylesheet';link.href=new URL('../css/future-scene.css',import.meta.url).href;doc.head.appendChild(link);}
  function removeEntities(){if(label)viewer.entities.remove(label);if(cell)viewer.entities.remove(cell);label=cell=null;visualKey=null;}
  function stopPlume(){if(!ownedPlume)return;const previous=ownedPlume;ownedPlume=null;emit('cs:environment-layer',{layer:'plume',enabled:false,siteId:previous.siteId,owner:'future-scene'});}
  function paint(){
    if(disposed)return;
    presentation=futureScenePresentation(state,{group});
    if(!presentation){removeEntities();stopPlume();emit('cs:future-scene',{siteId:state.siteId,year:state.year,presentation:null});viewer.scene.requestRender();return;}
    const anchor=anchors.get(state.siteId),position=C.Cartesian3.fromDegrees(anchor?.lon??presentation.position.lon,anchor?.lat??presentation.position.lat,finite(anchor?.roofHeight)?anchor.roofHeight+35:280);
    const nextVisual=JSON.stringify([state.siteId,presentation.label,presentation.note,presentation.bounds,presentation.color,anchor?.lat,anchor?.lon,anchor?.roofHeight]);
    if(nextVisual!==visualKey){
      const color=C.Color.fromCssColorString(presentation.color);
      if(!label){label=viewer.entities.add({id:'future-model-readout',position,label:{text:presentation.label,font:'14px sans-serif',fillColor:C.Color.WHITE,outlineColor:C.Color.BLACK,outlineWidth:2,style:C.LabelStyle?.FILL_AND_OUTLINE,showBackground:true,backgroundColor:C.Color.fromCssColorString('#10242d').withAlpha(.94),backgroundPadding:new C.Cartesian2(12,8),pixelOffset:new C.Cartesian2(0,-95),disableDepthTestDistance:0,distanceDisplayCondition:new C.DistanceDisplayCondition(0,1600000)}});label.addProperty?.('lowPoly');label.lowPoly=true;}
      else {label.position=position;label.label.text=presentation.label;}
      label.description=presentation.note;
      label.label.show=!doc?.getElementById?.('sceneModelReadout');
      if(presentation.bounds){
        if(!cell){cell=viewer.entities.add({id:'future-climate-source-cell',rectangle:{coordinates:C.Rectangle.fromDegrees(...presentation.bounds),material:color.withAlpha(.035),outline:true,outlineColor:color.withAlpha(.7)}});cell.addProperty?.('lowPoly');cell.lowPoly=true;}
        else {cell.rectangle.coordinates=C.Rectangle.fromDegrees(...presentation.bounds);cell.rectangle.material=color.withAlpha(.035);cell.rectangle.outlineColor=color.withAlpha(.7);}
        cell.description=presentation.note;
      }else if(cell){viewer.entities.remove(cell);cell=null;}
      visualKey=nextVisual;
    }
    if(presentation.kind==='plume'){
      if(ownedPlume?.raw!==presentation.raw||ownedPlume?.siteId!==state.siteId){stopPlume();ownedPlume={raw:presentation.raw,siteId:state.siteId};emit('cs:environment-layer',{layer:'plume',enabled:true,siteId:state.siteId,result:presentation.raw,owner:'future-scene'});}
    }else stopPlume();
    emit('cs:future-scene',{siteId:state.siteId,year:state.year,group,presentation});viewer.scene.requestRender();
  }
  function setState(next){if(disposed||!next)return;if(next.siteId!==next.site?.id)return;if(selectedSiteId&&next.siteId!==selectedSiteId){pendingState=next;return;}selectedSiteId=next.siteId;state=next;group=next.group||group;paint();}
  function switchSite(next){stopPlume();selectedSiteId=next.id;if(pendingState?.siteId===next.id){state=pendingState;group=state.group||group;pendingState=null;}else if(state.siteId!==next.id)state={...state,site:next,siteId:next.id,products:{},climate:null,plume:null,agriculture:null};paint();}
  on('cs:future-state',event=>setState(event.detail?.state));
  on('cs:campus-ready',event=>{const d=event.detail;if(!d?.siteId||!safePoint(d.marker)||!finite(d.marker.roofHeight))return;anchors.delete(d.siteId);anchors.set(d.siteId,d.marker);while(anchors.size>12)anchors.delete(anchors.keys().next().value);if(d.siteId===state.siteId)paint();});
  on('cs:future-view',event=>{const detail=event.detail;if(!detail||detail.siteId&&detail.siteId!==state.siteId)return;if(!['heat','water','air','vegetation'].includes(detail.group))return;group=detail.group;if(detail.enabled===true&&group==='air')ownedPlume=null;paint();});
  on('cs:site',event=>{if(event.detail?.site)switchSite(event.detail.site);});
  on('cs:location',event=>{if(event.detail?.site)switchSite(event.detail.site);});
  on('cs:year',event=>{const detail=event.detail;if(!finite(detail?.year)||detail.siteId&&detail.siteId!==state.siteId)return;state={...state,year:detail.year};paint();});
  paint();
  return {setState,get presentation(){return presentation;},get count(){return Number(!!label)+Number(!!cell);},destroy(){if(disposed)return;disposed=true;for(const [name,listener]of listeners)eventTarget.removeEventListener(name,listener);listeners.length=0;removeEntities();stopPlume();viewer.scene.requestRender();}};
}
