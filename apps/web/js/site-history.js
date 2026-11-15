// Curated event evidence, not a reconstruction of historical footprints. Dates
// retain their source precision; an announcement is never promoted to opening.
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const source=(title,url,publisher,evidence='primary')=>({title,url,publisher,evidence});
export const HISTORY_SOURCES=freeze({
  memphis:source('xAI utility support, July 9, 2024','https://memphistn.gov/wp-content/uploads/2025/01/xAI-water-and-electric-7-9-24-final.pdf','City of Memphis / MLGW'),
  xai:source('Colossus project timeline','https://x.ai/colossus','xAI'),
  colossus2:source('Second Memphis site acquired; construction planned','https://www.bisnow.com/news/national/data-center/elon-musks-ai-firm-plans-second-memphis-data-center-128407','Bisnow','reported-secondary'),
  abilene:source('Abilene expansion announcement, March 18, 2025','https://www.crusoe.ai/resources/newsroom/crusoe-expands-ai-data-center-campus-in-abilene-to-1-2-gigawatts','Crusoe'),
  google:source('The Dalles data-center milestones','https://www.datacenters.google/locations/oregon/','Google'),
  study:source('Case-study reference dates','data/sites.json','Footprint Atlas','study-reference'),
  loudoun:source('Loudoun data-center industry context','https://biz.loudoun.gov/key-business-sectors/data-centers/','Loudoun County Economic Development'),
});
export const SITE_HISTORY=freeze({
  colossus1:{scope:'facility',before:'Before the 2024 data-center conversion · former Electrolux industrial site',after:'Colossus · industrial building converted for data-center use',
    note:'The existing industrial shell is retained. Present-day architecture and equipment are reference scenery, not their historical appearance.',
    events:[{id:'colossus1-conversion',date:'2024',precision:'year',kind:'conversion-announced',title:'Former Electrolux site converted for Colossus',confidence:'documented-site-conversion',source:HISTORY_SOURCES.memphis,
      note:'The July 9, 2024 city utility briefing identifies the reused factory. This record does not establish an exact conversion day or opening date for every current structure.'}],
    mappedUseChanges:[{buildingId:'way/1381264361',year:2024,before:'Former Electrolux industrial building',after:'Colossus data-center conversion',source:HISTORY_SOURCES.memphis}],verifiedBuildings:[]},
  colossus2:{scope:'project-area',before:'Before the 2025 second-site announcement · existing structures retained',after:'Colossus 2 · 2025 acquisition and construction plan',
    note:'The computing campus and associated Southaven turbine site are different locations. A project announcement does not date each mapped building or establish opening.',
    events:[{id:'colossus2-project',date:'2025-03-10',precision:'day',kind:'construction-announced',title:'Second Memphis site acquisition and construction plans reported',confidence:'reported-announcement',source:HISTORY_SOURCES.colossus2,
      note:'Report publication date. Work was described as potentially starting that week; no exact opening date is asserted.'}],mappedUseChanges:[],verifiedBuildings:[]},
  abilene:{scope:'campus',before:'Before June 2024 campus construction · current mapped layout retained',after:'Abilene · construction began June 2024',
    note:'The first construction phase and later expansions are distinct. No per-building opening or completion dates are inferred from the campus milestone.',
    events:[{id:'abilene-construction',date:'2024-06',precision:'month',kind:'construction-start',title:'Abilene campus construction begins',confidence:'operator-reported',source:HISTORY_SOURCES.abilene,
      note:'Crusoe retrospectively reports June 2024 construction start. This does not mean the campus opened then.'}],mappedUseChanges:[],verifiedBuildings:[]},
  thedalles:{scope:'multi-campus',before:'Before Google’s first The Dalles opening in 2006 · current layout is reference',after:'Google The Dalles · first opening in 2006; later campuses added separately',
    note:'The 2006 milestone applies to the first facility, not every current extension. Current footprints are not a historical building inventory.',
    events:[{id:'thedalles-first-opening',date:'2006',precision:'year',kind:'first-opening',title:'Google opens its first The Dalles data center',confidence:'operator-reported',source:HISTORY_SOURCES.google,note:'Only the year is verified; no January opening date is invented.'},
      {id:'thedalles-fourth-construction',date:'2015',precision:'year',kind:'expansion-construction',title:'Construction of a fourth The Dalles data center begins',confidence:'operator-reported',source:HISTORY_SOURCES.google,note:'A later expansion milestone, not an opening date for all current buildings.'}],mappedUseChanges:[],verifiedBuildings:[]},
  ashburn:{scope:'region',before:'Data Center Alley · multiple operators and building generations',after:'Data Center Alley · regional study, not a single facility',
    note:'2012 is this study’s regional comparison reference, not a universal opening or construction date. Contributed map dates remain unverified.',
    events:[{id:'ashburn-study-reference',date:'2012',precision:'year',kind:'study-reference',title:'Regional study reference year',confidence:'study-context-only',source:HISTORY_SOURCES.study,contextSource:HISTORY_SOURCES.loudoun,
      note:'No claim that all Northern Virginia data centers were built or opened in 2012.'}],mappedUseChanges:[],verifiedBuildings:[]},
});

export function describeSiteHistory(siteId,year=2025){
  const history=SITE_HISTORY[siteId],selectedYear=Number.isFinite(Number(year))?Math.round(Number(year)):2025;
  if(!history)return {siteId,year:selectedYear,events:[],current:null,scope:'unknown',notice:'No verified facility chronology for this location. Present-day mapped buildings remain reference scenery.',historicalMap:false};
  const events=history.events.map(event=>({...event,year:Number(event.date.slice(0,4))}));
  const occurred=events.filter(event=>event.year<=selectedYear),current=occurred.at(-1)||null;
  return {siteId,year:selectedYear,scope:history.scope,events,current,upcoming:events.find(event=>event.year>selectedYear)||null,
    label:current?history.after:history.before,notice:history.note,historicalMap:false};
}
export function historyTransition(siteId,fromYear,toYear){
  const history=describeSiteHistory(siteId,toYear),forward=Number(toYear)>=Number(fromYear);
  const crossed=history.events.filter(event=>forward?event.year>fromYear&&event.year<=toYear:event.year<=fromYear&&event.year>toYear);
  return {direction:forward?'forward':'backward',crossed:forward?crossed:crossed.toReversed(),history};
}
/** Selective hiding requires an exact source building ID and independently
 * verified NEW construction date. OSM start_date and campus onset never suffice.
 * No current bundled record satisfies that test, so existing buildings remain.
 */
export function buildingHistoryState(siteId,building,year,{verifiedBuildings=SITE_HISTORY[siteId]?.verifiedBuildings||[]}={}){
  const id=building?.sourceFootprintId||building?.id;
  const record=verifiedBuildings.find(record=>record.buildingId===id&&record.verified===true&&record.kind==='new-construction'&&record.source?.evidence==='primary'&&/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(record.date||''));
  const change=SITE_HISTORY[siteId]?.mappedUseChanges.find(record=>record.buildingId===id);
  return {visible:!(record&&Number(year)<Number(record.date.slice(0,4))),usageLabel:change?(Number(year)<change.year?change.before:change.after):null,
    evidence:record||change||null,mappedStartDate:building?.history?.mappedStartDate||null,historicalGeometry:false};
}
export function mappedBuildingHistory(feature){return {sourceFootprintId:feature.id,mappedStartDate:typeof feature.tags?.start_date==='string'?feature.tags.start_date:null,evidence:'osm-contributed-unverified',verified:false,canHide:false};}
