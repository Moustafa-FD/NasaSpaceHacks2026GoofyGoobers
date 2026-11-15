import {describeSiteHistory} from './site-history.js';
const source=(title,url,publisher,evidence='reported-secondary')=>({title,url,publisher,evidence});
export const WATER_SOURCES=Object.freeze({
  cityRelease:source('Released The Dalles water figures','https://www.datacenterdynamics.com/en/news/we-now-know-how-much-water-googles-oregon-data-centers-use-after-city-drops-lawsuit-against-journalists/','DCD, reporting city records via The Oregonian'),
  google:source('Data Center Water Profile: The Dalles, April 2023','https://www.gstatic.com/gumdrop/sustainability/2023-data-center-water-profile-the-dalles.pdf','Google','operator-primary'),
  xaiBills:source('xAI utility-bill reporting','https://aiwateruse.org/companies/xai','AIWaterUse.org, citing utility-bill reporting'),
  estimate:source('MLGW project demand estimate, June 22, 2024','https://www.actionnews5.com/2024/06/22/90-million-electricity-bill-costs-maintenance-elon-musks-new-supercomputer-projected-be-millions/','Action News 5, quoting MLGW'),
  request:source('Combined xAI water request, May 4, 2026','https://www.eenews.net/articles/xai-sidelines-major-water-reuse-project-as-ipo-looms/','E&E News / POLITICO, quoting MLGW'),
});
// These are discrete reports with different accounting boundaries. No annual
// interpolation, daily conversion, evaporation calculation or pond-volume proxy.
const WATER={
  thedalles:[
    {id:'thedalles-city-2017',year:2017,value:124200000,unit:'US gal',period:'Calendar year 2017',aggregation:'annual-total',metric:'reported-water-use',status:'reported',scope:'Google facilities served by The Dalles city utility',reportedAt:'2022-12-19',source:WATER_SOURCES.cityRelease,note:'Released city figures reported by journalists; not a measured evaporation total.'},
    {id:'thedalles-city-2021',year:2021,value:355100000,unit:'US gal',period:'Calendar year 2021',aggregation:'annual-total',metric:'reported-water-use',status:'reported',scope:'Google facilities served by The Dalles city utility',reportedAt:'2022-12-19',source:WATER_SOURCES.cityRelease,note:'Annual reported water use; not a daily flow or allocation to an individual building.'},
    {id:'thedalles-google-2021',year:2021,value:275000000,approximation:'almost',unit:'US gal',period:'Calendar year 2021',aggregation:'annual-total',metric:'reported-consumption',status:'reported',scope:'Google The Dalles facilities, operator consumption accounting',reportedAt:'2023-04',source:WATER_SOURCES.google,note:'Different metric and reporting boundary from city-use figures. Do not subtract them to estimate evaporation or discharge.'},
  ],
  colossus1:[
    {id:'colossus1-planned-2024',year:2024,value:1300000,unit:'US gal/day',period:'2024 estimate for full operation',aggregation:'planned-maximum-day',metric:'projected-demand',status:'planned',scope:'Original Colossus project estimate',reportedAt:'2024-06-22',source:WATER_SOURCES.estimate,note:'MLGW demand estimate, not measured daily use and not verified here as a contractual allowance.'},
    {id:'colossus1-peak-2025',year:2025,value:381000,approximation:'about',unit:'US gal/day',period:'Summer 2025 reported peak rate',aggregation:'reported-peak-rate',metric:'reported-water-use',status:'reported-peak',scope:'Original Colossus Memphis facility',source:WATER_SOURCES.xaiBills,note:'Secondary utility-bill summary; averaging interval not independently verified. Not an annual or typical-day average; no continuous daily series is available.'},
  ],
  colossus2:[{id:'xai-combined-request-2026',year:2026,value:3700000,unit:'US gal/day',period:'Request reported May 4, 2026',aggregation:'requested-capacity',metric:'requested-water-supply',status:'requested',scope:'Combined original and second Memphis data centers',reportedAt:'2026-05-04',source:WATER_SOURCES.request,note:'Combined requested supply, not measured use at Colossus 2 or the Southaven turbine site.'}],
};
const NOISE={colossus2:[{id:'southaven-resident-2025',year:2025,value:null,unit:'dB',period:'Resident report published November 24, 2025',metric:'resident-noise-complaint',status:'reported-qualitative',scope:'Southaven residents near the associated turbine site',location:null,locationPrecision:'not-available',weighting:null,averagingPeriod:null,eligibleForSpatialModel:false,
  source:source('Southaven residents report turbine noise','https://mississippitoday.org/2025/11/24/southaven-residents-fear-pollution-complain-of-noise-from-elon-musks-xai-data-center-turbines/','Mississippi Today'),note:'Complaints are documented; the legacy 70 dB indoor figure was not verified in this source. No calibrated level, outdoor survey or noise contour is supplied.'}]};
export function isWaterUseRecord(record){return Number.isFinite(record?.value)&&record.value>=0&&typeof record.unit==='string'&&typeof record.period==='string'&&['reported','reported-peak','measured'].includes(record.status)&&['reported-water-use','reported-consumption'].includes(record.metric);}
export function formatWaterRecord(record){
  if(!record)return 'No facility water-use total available';
  const amount=record.value>=1000000?`${(record.value/1000000).toLocaleString('en-US',{maximumFractionDigits:3})} million`:record.value.toLocaleString('en-US');
  return `${record.approximation?record.approximation+' ':''}${amount} ${record.unit} · ${record.period}`;
}
export function resolveSiteEvidence(siteId,year=2025){
  const records=(WATER[siteId]||[]).map(record=>({...record,source:{...record.source}})),reported=records.filter(isWaterUseRecord);
  const candidates=reported.filter(record=>record.year<=year).sort((a,b)=>b.year-a.year||Number(a.metric==='reported-consumption')-Number(b.metric==='reported-consumption'));
  const selected=candidates[0]||null,exact=!!selected&&selected.year===Number(year);
  return {siteId,year:Number(year),history:describeSiteHistory(siteId,year),water:{records,selected,exact,availability:selected?(exact?'reported-for-year':'historical-report-only'):'unknown',
    summary:selected?formatWaterRecord(selected):records.some(record=>record.status==='requested')?'Requested supply exists; measured facility use unavailable':'No verified facility water-use total for this selection',
    note:'Water use, withdrawal, consumption, requested capacity and evaporation are different quantities. Missing years are not zero; no values are interpolated.'},
    noise:{records:(NOISE[siteId]||[]).map(record=>({...record,source:{...record.source}})),availability:NOISE[siteId]?.length?'resident-report-only':'unknown',spatialModel:false},
    nature:{availability:'source-specific',note:'Regional NDVI and station observations do not establish individual plant death, crop yield or facility causation.'}};
}
