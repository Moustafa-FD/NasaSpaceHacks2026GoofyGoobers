import {resolveSiteEvidence,isWaterUseRecord} from './site-evidence.js';
import {buildingHistoryState,historyTransition} from './site-history.js';
import {sampleElevation} from './landscape.js';

let sequence=0;
export function historySceneLabel(siteId,year){
  const history=resolveSiteEvidence(siteId,year).history,first=history.events[0];
  if(!first)return 'Current mapped layout · historical dates unavailable';
  if(siteId==='ashburn')return 'Regional study · 2012 is not every building’s date';
  if(Number(year)<first.year)return `Before ${first.date} ${first.kind==='first-opening'?'first opening':first.kind==='conversion-announced'?'conversion':'project'} · current layout retained`;
  return first.kind==='conversion-announced'?`Data-center conversion · ${first.date}`:first.kind==='construction-start'?`Construction began ${first.date} · not an opening date`:first.kind==='construction-announced'?`Project announced ${first.date} · opening unverified`:`First opening ${first.date} · later buildings have separate dates`;
}
export function anchoredWaterText(evidence){
  const record=evidence.water.selected;if(!isWaterUseRecord(record))return null;
  const value=record.value>=1e6?`${(record.value/1e6).toLocaleString('en-US',{maximumFractionDigits:3})} million`:record.value.toLocaleString('en-US');
  const type=record.aggregation==='annual-total'?'annual reported '+(record.metric==='reported-consumption'?'consumption':'water use'):'reported peak rate';
  const scope=evidence.siteId==='thedalles'?'all Google The Dalles facilities':'original Colossus facility';
  return `${record.year} · ${record.approximation?record.approximation+' ':''}${value} ${record.unit}\n${type} · ${scope}${evidence.water.exact?'':'\nhistorical reference, not selected-year use'}`;
}

/** At most two depth-tested labels. Call only for the selected retained base
 * patch; regional reports are never reassigned to an arbitrary streamed campus.
 */
export function attachSceneEvidence(viewer,site,data,{base=true}={}){
  const C=Cesium,entities=[];let active=false,destroyed=false,year=2025;
  const campuses=data.campuses||[],preferred=campuses.find(c=>buildingHistoryState(site.id,c,year).usageLabel);
  const campus=preferred||campuses[0];
  if(!base||!campus||!data.center)return {setActive(){},setYear(){},destroy(){},get count(){return 0;}};
  const frame=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(data.center.lon,data.center.lat));
  const baseHeight=Number.isFinite(campus.baseHeight)?campus.baseHeight:(sampleElevation(data.elevation,campus.x,campus.y)??0)+4-(campus.x**2+campus.y**2)/(2*6371000)+(campus.padLiftM||0);
  const position=()=>C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(campus.x,campus.y,baseHeight+(campus.height||12)+6+(data.heightOffset?.(campus.x,campus.y)||0)),new C.Cartesian3());
  function label(kind,offset,range){
    const entity=viewer.entities.add({id:`scene-evidence-${site.id}-${++sequence}-${kind}`,show:false,position:position(),label:{text:'',font:'11px sans-serif',fillColor:C.Color.WHITE,outlineColor:C.Color.BLACK,outlineWidth:2,style:C.LabelStyle?.FILL_AND_OUTLINE,
      showBackground:true,backgroundColor:C.Color.fromCssColorString('#14262e').withAlpha(.84),backgroundPadding:new C.Cartesian2(7,4),pixelOffset:new C.Cartesian2(0,offset),
      distanceDisplayCondition:new C.DistanceDisplayCondition(0,range),disableDepthTestDistance:0}});
    // Match the app's existing low-poly pick guard so labels never start an
    // unrelated live satellite sampling request when clicked.
    entity.addProperty?.('lowPoly');entity.lowPoly=true;entities.push(entity);return entity;
  }
  const historyLabel=label('history',-54,2600),waterLabel=label('water',-106,1900);
  function paint(){
    if(destroyed)return;
    const evidence=resolveSiteEvidence(site.id,year),water=anchoredWaterText(evidence);
    historyLabel.label.text=buildingHistoryState(site.id,campus,year).usageLabel||historySceneLabel(site.id,year);
    historyLabel.position=position();waterLabel.position=position();waterLabel.label.text=water||'';
    historyLabel.show=active;waterLabel.show=active&&!!water;
  }
  return {setActive(value){if(destroyed)return;active=!!value;paint();},setYear(value){if(destroyed)return;year=Number(value);paint();},
    get count(){return entities.length;},destroy(){if(destroyed)return;destroyed=true;for(const entity of entities)viewer.entities.remove(entity);entities.length=0;}};
}

/** One app-lifetime evidence controller. The optional host gets a compact
 * source-linked event notice; scene controllers only consume the same resolver.
 */
export function attachSiteEvidence({site,year=2025,host=null}={}){
  let currentSite=site,currentYear=Number(year),disposed=false,panel=null;
  if(host){
    panel=document.createElement('aside');panel.id='sceneHistoryNotice';panel.className='scene-history-notice';panel.setAttribute('aria-live','polite');host.appendChild(panel);
    if(!document.getElementById('scene-evidence-style')){const link=document.createElement('link');link.id='scene-evidence-style';link.rel='stylesheet';link.href=new URL('../css/scene-evidence.css',import.meta.url).href;document.head.appendChild(link);}
  }
  function paint(fromYear=currentYear){
    if(disposed||!currentSite)return null;
    const evidence=resolveSiteEvidence(currentSite.id,currentYear),transition=historyTransition(currentSite.id,fromYear,currentYear);
    evidence.transition=transition;window.dispatchEvent(new CustomEvent('cs:facility-evidence',{detail:evidence}));
    if(panel){
      panel.replaceChildren();const event=transition.crossed[0]||evidence.history.current||evidence.history.upcoming;
      panel.hidden=!event;if(!event)return evidence;
      Object.assign(panel.dataset,{site:currentSite.id,year:currentYear,event:event.kind,date:event.date,confidence:event.confidence});
      const heading=document.createElement('strong');heading.textContent=transition.crossed.length?`${transition.direction==='backward'?'Rewound before':'Crossed'} ${event.date} · ${event.title}`:`${event.date} · ${event.title}`;panel.appendChild(heading);
      const text=document.createElement('span');text.textContent=evidence.history.label;panel.appendChild(text);
      const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Historical context and source';details.appendChild(summary);
      const note=document.createElement('p');note.textContent=evidence.history.notice+' '+event.note+' Evidence: '+event.confidence.replaceAll('-',' ')+'.';details.appendChild(note);
      const link=document.createElement('a');link.href=event.source.url;link.textContent=event.source.publisher+' · '+event.source.title;link.target='_blank';link.rel='noopener';details.appendChild(link);panel.appendChild(details);
    }
    return evidence;
  }
  const setSite=value=>{currentSite=value;return paint();};
  const setYear=value=>{const previous=currentYear;currentYear=Number(value);return paint(previous);};
  const onSite=event=>{if(event.detail?.site)setSite(event.detail.site);};
  const onYear=event=>{if(event.detail?.siteId&&event.detail.siteId!==currentSite?.id)return;if(Number.isFinite(event.detail?.year))setYear(event.detail.year);};
  window.addEventListener('cs:site',onSite);window.addEventListener('cs:year',onYear);paint();
  return {setSite,setYear,get evidence(){return currentSite?resolveSiteEvidence(currentSite.id,currentYear):null;},destroy(){if(disposed)return;disposed=true;window.removeEventListener('cs:site',onSite);window.removeEventListener('cs:year',onYear);panel?.remove();}};
}
