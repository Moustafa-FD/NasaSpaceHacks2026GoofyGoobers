import {summarizeRegionalEvidence} from './regional-evidence.js';
import {summarizeSiteAudit,siteAuditWaterReadings} from './site-audit.js';

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const n=(v,d=2)=>!finite(v)?'Unknown':Math.abs(v)>0&&Math.abs(v)<10**-d?v.toExponential(2):v.toLocaleString('en-US',{maximumFractionDigits:d});
const note=value=>`<p class="ew-note">${h(value)}</p>`;
const link=(url,label='Source')=>{try{const u=new URL(url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?`<a href="${h(u.href)}" target="_blank" rel="noopener noreferrer">${h(label)} ↗</a>`:'';}catch{return '';}};
export const WORKBENCH_FIELDS={
  heat:[['heatMw','Sensible heat released to air','MW',0,100000],['effectiveHeightM','Effective release height','m',1,300],['airDensityKgM3','Air density','kg/m³',.5,2],['specificHeatJkgK','Specific heat capacity of air','J/(kg·K)',800,1200]],
  air:[['emissionRateGs','Emission rate for this scenario year','g/s',0,100000],['pollutant','Pollutant / constituent','text'],['effectiveHeightM','Effective release height','m',1,300]],
  water:[['withdrawalM3s','Annual-average withdrawal','m³/s',0,100000],['returnM3s','Annual-average returned flow','m³/s',0,100000],['riverFlowM3s','Upstream river flow at discharge','m³/s',0,1000000],['upstreamTempC','Upstream water temperature','°C',-2,60],['dischargeTempC','Returned/discharge temperature','°C',-2,100],['upstreamMgL','Upstream constituent concentration','mg/L',0,1000000],['dischargeMgL','Discharge constituent concentration','mg/L',0,1000000],['pollutant','Constituent for both concentrations','text']],
  noise:[['soundPowerDbA','Source sound power (not measured sound pressure)','dB(A) re 1 pW',0,200],['receptorDistanceM','Distance from source to receptor','m',1,10000],['backgroundDbA','Background sound pressure (optional)','dB(A)',0,160]],
};
const validYear=year=>Number.isInteger(year)&&year>=2020&&year<=2100;
function pointLocation(site){
  if(['ashburn','colossus1','colossus2','abilene','thedalles'].includes(site?.id))return {siteId:site.id};
  if(!finite(site?.lat)||!finite(site?.lon)||Math.abs(site.lat)>90||Math.abs(site.lon)>180)throw new Error('Select a valid place before calculating.');
  return {point:{latitude:site.lat,longitude:site.lon}};
}
/** Empty fields remain absent, including genuine zero vs missing input. */
/** "2020–2035, 2050": contiguous runs, never implying uncalculated years. */
export function yearRanges(years){
  const ys=[...new Set(years)].filter(Number.isInteger).sort((a,b)=>a-b),out=[];
  for(const y of ys){const last=out.at(-1);if(last&&y===last[1]+1)last[1]=y;else out.push([y,y]);}
  return out.map(([a,b])=>a===b?String(a):`${a}–${b}`).join(', ')||'none';
}
/** Years one calculation covers. The same supplied inputs are reused for each year (stated on the result). */
export function workbenchYears(year,span='single'){
  if(span==='through2035')return Array.from({length:16},(_,i)=>2020+i);
  if(span==='through2100')return Array.from({length:81},(_,i)=>2020+i);
  return [year];
}
export function buildWorkbenchRequest({site,year,domain='heat',values={},evidence='assumed',citation='',url='',landUse='urban',advancedJson='',span='single'}={}, {missingOnly=false}={}){
  const selected=Number(year);if(!validYear(selected))throw new Error('Choose an explicit screening year from 2020 to 2100.');
  const location=pointLocation(site);
  if(missingOnly)return {schemaVersion:'1.0',kind:'environment-screening',...location,years:[{year:selected}]};
  if(advancedJson.trim()){
    let body;try{body=JSON.parse(advancedJson);}catch{throw new Error('Advanced source options must be valid JSON.');}
    if(body?.schemaVersion!=='1.0'||body.kind!=='environment-screening'||!Array.isArray(body.years)||!body.years.length||body.years.length>81)throw new Error('Advanced JSON must be a complete environment-screening request with 1–81 year records.');
    if(location.siteId?body.siteId!==location.siteId:body.siteId||Math.abs(body.point?.latitude-site.lat)>1e-6||Math.abs(body.point?.longitude-site.lon)>1e-6||!finite(body.point?.latitude)||!finite(body.point?.longitude))throw new Error('Advanced JSON must use the selected study site or exact selected coordinates.');
    return body;
  }
  if(!WORKBENCH_FIELDS[domain])throw new Error('Choose Heat, Air, Water or Noise.');
  const row={year:selected},extras={};let count=0;
  for(const [key,label,unit,min,max]of WORKBENCH_FIELDS[domain]){
    const raw=values[key];if(raw===undefined||raw===null||String(raw).trim()==='')continue;
    if(unit==='text'){if(String(raw).trim().length>80)throw new Error(`${label} must be at most 80 characters.`);row[key]=String(raw).trim();continue;}
    const value=Number(raw);if(!finite(value)||value<min||value>max)throw new Error(`${label} must be between ${min} and ${max} ${unit}.`);
    if(['effectiveHeightM','airDensityKgM3','specificHeatJkgK','receptorDistanceM','backgroundDbA'].includes(key))extras[key]=value;else row[key]=value;count++;
  }
  if(!count)throw new Error('Enter sourced inputs, or use “Check missing inputs” to see what is needed.');
  if(domain==='noise'&&String(values.noiseContours||'').trim()){
    const levels=String(values.noiseContours).trim().split(/[,\s]+/).map(Number);
    if(!levels.length||levels.length>5||new Set(levels).size!==levels.length||levels.some(v=>!finite(v)||v<10||v>140))throw new Error('Choose 1–5 unique comparison levels from 10 to 140 dB(A). These are display levels, not health or legal thresholds.');
    extras.noiseContours=levels;
  }
  if(!['reported','assumed'].includes(evidence)||!String(citation).trim()||String(citation).length>1000)throw new Error('Add a source citation or describe the explicit assumptions for these inputs.');
  const source={evidence,citation:String(citation).trim()};
  if(url.trim()){let u;try{u=new URL(url);}catch{throw new Error('Use a valid HTTP(S) source URL.');}if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw new Error('Use a source URL without credentials.');source.url=u.href;}
  row.source=source;const years=workbenchYears(selected,span);if(!years.includes(selected))years.push(selected);
  const body={schemaVersion:'1.0',kind:'environment-screening',...location,years:years.sort((a,b)=>a-b).map(y=>({...row,year:y}))};
  if(['heat','air'].includes(domain)&&extras.effectiveHeightM!==undefined){
    if(!['urban','rural'].includes(landUse))throw new Error('Choose urban or rural land use.');
    body.dispersion={effectiveHeightM:extras.effectiveHeightM,landUse,source};for(const key of ['airDensityKgM3','specificHeatJkgK'])if(extras[key]!==undefined)body.dispersion[key]=extras[key];
  }
  if(domain==='noise'&&extras.receptorDistanceM!==undefined)body.receptors=[{name:'Selected receptor',distanceM:extras.receptorDistanceM}];
  if(domain==='noise'&&extras.backgroundDbA!==undefined)body.backgroundNoise={dbA:extras.backgroundDbA,source};
  if(domain==='noise'&&extras.noiseContours)body.noiseContourLevelsDbA=extras.noiseContours;
  return body;
}

export function regionalEvidenceChartHtml(summary){
  const rows=summary?.annual||[],valid=rows.filter(p=>finite(p.value));if(!valid.length)return '';
  const first=rows[0].year,last=rows.at(-1).year,low=Math.min(...valid.map(p=>p.value)),high=Math.max(...valid.map(p=>p.value)),span=high-low||Math.max(1,Math.abs(high)*.1);
  let path='',previous=null;
  for(const row of rows){if(!finite(row.value)){previous=null;continue;}const x=54+(row.year-first)/(last-first||1)*286,y=146-(row.value-low)/span*118;path+=`${previous!==null&&row.year===previous+1?'L':'M'}${x.toFixed(1)},${y.toFixed(1)} `;previous=row.year;}
  return `<svg class="ew-chart" viewBox="0 0 360 186" role="img" aria-label="${h(summary.label)} annual recorded history, ${first} to ${last}, ${h(summary.unit)}. Gaps remain missing."><text x="3" y="30">${h(n(high,1))}</text><text x="3" y="150">${h(n(low,1))}</text><line x1="54" y1="146" x2="340" y2="146" stroke="#42606b"/><path d="${path}" stroke="#8cdec1" fill="none" stroke-width="3"/><text x="54" y="176">${first}</text><text x="306" y="176">${last}</text></svg>`;
}
export function regionalTrendHtml(trend,unit){
  if(!trend)return '';
  const period=trend.period?.start&&trend.period?.end?`${trend.period.start}–${trend.period.end}`:'the entire available record',ci=trend.sen?.ciPerDecade,confidence=finite(trend.alpha)?`${n((1-trend.alpha)*100,0)}% `:'';
  return `<section class="ew-trend"><h4>Python trend analysis</h4>${note(`Historical record: ${period}.`)}<p>${h(trend.summary||trend.status||'No statistical summary supplied.')}</p>${finite(trend.sen?.slopePerDecade)?`<p><b>Rate: ${h(n(trend.sen.slopePerDecade,3))} ${h(unit)} per decade.</b></p>`:''}<details><summary>Statistical methods &amp; uncertainty</summary>${finite(trend.mannKendall?.pValue)?note(`Mann–Kendall p = ${n(trend.mannKendall.pValue,5)}.`):''}${Array.isArray(ci)&&ci.length===2&&ci.every(finite)?note(`${confidence}Sen slope interval: ${n(ci[0],3)} to ${n(ci[1],3)} ${unit} per decade.`):''}${note('These tests and intervals describe the whole historical trend, not a selected-year difference or a future prediction.')}${(trend.limitations||[]).map(note).join('')}</details></section>`;
}
export function regionalEvidenceHtml(product,{year,variable}={}){
  if(!product)return note('Loading prepared regional evidence…');
  const summary=summarizeRegionalEvidence(product,{year,variable:variable||product.variables?.find(v=>v.status==='available')?.id});
  const historyJump=!summary.available&&Number.isInteger(summary.lastYear)?`<button type="button" data-ew-scenario-year="${summary.lastYear}">View ${summary.lastYear} source data</button>`:'';
  return `<div class="ew-reading"><span>${h(summary.label)} · ${year}</span><strong>${summary.available?h(n(summary.value,2)):'Unknown'} <small>${h(summary.unit)}</small></strong></div>${summary.available?note(`${summary.validMonths}/12 valid source months · ${summary.aggregation||'Source annual summary'}`):`<p class="ew-gap">${h(summary.reason)}</p>`}${historyJump}${note(summary.resolution)}${link(summary.source?.url,'NASA source')}${regionalEvidenceChartHtml(summary)}${regionalTrendHtml(summary.trend,summary.unit)}${summary.importCommand?`<details><summary>Import source record</summary><code>${h(summary.importCommand)}</code></details>`:''}${(summary.caveats||[]).slice(0,3).map(note).join('')}`;
}
export function siteAuditHtml(audit,year){
  if(!audit)return note('Loading prepared source coverage…');
  const counts=summarizeSiteAudit(audit),readings=siteAuditWaterReadings(audit,year),observed=readings.filter(r=>r.available);
  const years=[...new Set((audit.stations||[]).flatMap(s=>(s.series||[]).flatMap(v=>(v.points||[]).filter(p=>finite(p.value)).map(p=>Number(String(p.date).slice(0,4))))))].filter(Number.isInteger).sort((a,b)=>b-a);
  const latest=years.find(y=>siteAuditWaterReadings(audit,y).some(r=>r.available));
  const historyJump=!observed.length&&Number.isInteger(latest)?`<button type="button" data-ew-scenario-year="${latest}">View ${latest} gauge data</button>`:'';
  return `<p><b>${counts.confirmed}</b> reviewed campus matches · <b>${counts.candidates}</b> inventory candidates</p>${note(`Inventory years: ${counts.inventoryYears.join(', ')||'not acquired'}. Nearby names and locations are not automatically joined.`)}<details><summary>Facility identity candidates</summary>${(audit.facilityMatches||[]).map(m=>`<article class="ew-source"><b>${h(m.name)}</b><p>${h(m.sourceFacilityId)} · ${h(m.status)} · ${n(m.distanceKm,1)} km</p>${link(m.sourceUrl,'Regulatory record')}${facilityInventoryHtml(m)}${(m.verifiedRelationships||[]).map(r=>note(`${r.type}: ${r.status}. ${r.note}`)).join('')}</article>`).join('')||note('No candidates were found in the cached source scope; this does not mean zero emissions.')}</details><h4>Water gauges · ${year}</h4>${observed.map(r=>`<article class="ew-reading"><span>${h(r.name)}</span><strong>${n(r.mean,1)} <small>${h(r.unit)}</small></strong><p>${r.validDays}/${r.expectedDays} daily means · ${h(r.stationId)}</p>${finite(r.meanM3s)?note(`${n(r.meanM3s,2)} m³/s after unit conversion`):''}${link(r.sourceUrl,'USGS daily records')}</article>`).join('')||note(`No sufficiently complete acquired discharge record for ${year}. Acquired station histories remain explicitly dated.`)}${observed.length?'<button type="button" data-ew-water-map>Show source gauges in 3D ↗</button>':''}${historyJump}<details><summary>Station and parameter coverage</summary>${(audit.stations||[]).map(s=>`<article class="ew-source"><b>${h(s.name)}</b><p>${h(s.id)} · ${n(s.distanceKm,1)} km · ${h(s.coverage?.status||'unknown')}</p>${(s.coverage?.parameters||[]).slice(0,8).map(p=>note(`${p.parameterName||p.parameterCode} · ${p.unit||'unknown unit'} · ${p.begin||'unknown start'} to ${p.end||'unknown end'}`)).join('')}${s.series?.length?note(`Downloaded periods: ${s.series.map(v=>`${v.period.start} to ${v.period.end}`).join('; ')}`):''}${link(s.sourceUrl,'Station')}</article>`).join('')}</details>${(audit.gaps||[]).map(g=>`<details><summary>${h(g.label)} · ${h(g.status)}</summary>${note(g.detail)}</details>`).join('')}${note(counts.note)}`;
}
export function facilityInventoryHtml(match){
  const years=(match?.emissions||[]).map(row=>row.year).filter(Number.isInteger),year=years.length?Math.max(...years):null,all=(match?.emissions||[]).filter(row=>row.year===year),rows=all.slice(0,20);
  if(!rows.length)return '';
  return `<details><summary>${year} reported inventory quantities</summary>${note('Candidate source record only; not automatically attributed to this campus or converted into ambient air quality.')}<div class="ew-table-scroll"><table><thead><tr><th>Pollutant</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${h(row.pollutant?.name||row.pollutant?.code||'Unknown')}</th><td>${h(n(row.amount,4))}</td><td>${h(row.unit||'Unknown')}</td></tr>`).join('')}</tbody></table></div>${all.length>rows.length?note(`First ${rows.length} of ${all.length} records for ${year}; inspect the source for the full inventory.`):''}${note('Different pollutants and source units are not added together.')}</details>`;
}
export function screeningResultsHtml(screening,year){
  const raw=screening?.result||screening,row=raw?.years?.find(r=>r.year===year),required=(raw?.requiredInputs||[]).filter(r=>r.year===year);
  if(!raw)return note('Calculate with supplied inputs, or check which inputs are still missing. No facility parameters are filled automatically.');
  const covered=(raw.years||[]).map(r=>r.year).filter(Number.isInteger),range=yearRanges(covered);
  if(!row)return `<p class="ew-gap">No screening record for ${year}. Calculated years: ${h(range)}.${validYear(year)?'':' Screening scenarios start in 2020.'}</p><div class="ew-actions">${validYear(year)?`<button type="button" data-ew-recalc-year="${year}">Calculate ${year} with the same inputs</button>`:''}${covered.filter(validYear).slice(-1).map(y=>`<button type="button" data-ew-scenario-year="${y}">View ${y} scenario</button>`).join('')}</div>`;
  const contours=Array.isArray(row.noiseContours)&&row.noiseContours.length?`<div class="ew-table-scroll"><table><caption>Chosen comparison levels · not health or legal limits</caption><thead><tr><th>Level dB(A)</th><th>Radius m</th><th>Status</th></tr></thead><tbody>${row.noiseContours.map(c=>`<tr><th scope="row">${h(n(c.levelDbA,1))}</th><td>${c.status==='conditional-screening'&&finite(c.radiusM)&&c.radiusM>=1&&c.radiusM<=10000?h(n(c.radiusM,1)):'Unknown'}</td><td>${h(c.status||'Unknown')}</td></tr>`).join('')}</tbody></table></div>`:'';
  return `<p class="ew-badge">${year} · conditional screening</p>${covered.length>1?note(`Calculated for ${range} with the same supplied inputs each year; moving the timeline shows each year. Inputs are not projected or adjusted by year.`):''}${(row.metrics||[]).map(m=>`<article class="ew-result"><span>${h(m.label)}</span><strong>${finite(m.value)?n(m.value,4):'Unknown'} <small>${h(m.unit)}</small></strong>${m.receptor?note(`${m.receptor.name} · ${n(m.receptor.distanceM,0)} m`):''}${m.note?note(m.note):''}</article>`).join('')||note('No numeric outputs: required source inputs remain missing.')}${contours}<details><summary>Required inputs by model</summary>${required.map(r=>`<article class="ew-source"><b>${h(r.domain)}</b>${note((r.fields||[]).join(', '))}${note(r.reason)}</article>`).join('')||note('All requested model inputs were supplied.')}</details>${raw.uncertainty?note(raw.uncertainty.note):''}${(row.source||raw.sources?.[0])?note(`Input evidence: ${(row.source||raw.sources[0]).evidence} · ${(row.source||raw.sources[0]).citation}`):''}`;
}

/** Stable input form: incoming model progress never erases typing. */
export function attachEvidenceWorkbench({site,year=2025,futureState,eventTarget=globalThis.window,document:doc=globalThis.document,container,onRequest,onSelectYear}={}){
  if(!doc||!eventTarget)throw new Error('Evidence workbench needs a document and event target.');
  let state=futureState||{site,siteId:site?.id,year},selectedVariable='',domain='heat',pending=false,status='',error='',destroyed=false,localResult=null,requestToken=0,yearDirty=false;
  const root=doc.createElement('section');root.id='evidenceWorkbench';root.className='evidence-workbench';root.setAttribute('aria-label','Regional evidence, coverage and local scenarios');
  root.innerHTML='<h2>Explore the evidence</h2><details data-ew-section="regional"><summary>Regional histories &amp; trends</summary><div class="ew-body"><label>Measurement<select data-ew-variable></select></label><div data-ew-regional></div></div></details><details data-ew-section="coverage"><summary>Source coverage &amp; water gauges</summary><div class="ew-body" data-ew-audit></div></details><details data-ew-section="scenario"><summary>Local impact scenario</summary><div class="ew-body"><p class="ew-note">Use reported inputs or explicit assumptions. These are conditional screening calculations, not calibrated predictions.</p><form data-ew-form><label>Model<select name="domain" data-ew-domain><option value="heat">Heat released to air</option><option value="air">Air emission contribution</option><option value="water">Water balance &amp; mixing</option><option value="noise">Noise at a receptor</option></select></label><label>Scenario year<input name="year" type="number" min="2020" max="2100" step="1" required/></label><label>Apply these inputs to<select name="span"><option value="through2035">Every year 2020–2035 (same inputs each year)</option><option value="single">This year only</option><option value="through2100">Every year 2020–2100 (same inputs each year)</option></select></label><div data-ew-fields></div><label>Input evidence<select name="evidence"><option value="assumed">Explicit assumptions</option><option value="reported">Reported source inputs</option></select></label><label>Source citation / assumptions<textarea name="citation" rows="3" maxlength="1000" placeholder="Describe where these input values came from"></textarea></label><label>Source URL (optional)<input name="url" type="url" placeholder="https://…"/></label><details><summary>Advanced complete JSON</summary><p class="ew-note">For multiple scenario years or separate input-source groups. A nonempty request replaces the guided form and must use the selected place.</p><textarea name="advancedJson" rows="8" spellcheck="false" aria-label="Advanced complete screening request"></textarea></details><div class="ew-actions"><button type="submit">Calculate supplied scenario</button><button type="button" data-ew-missing>Check missing inputs</button></div></form><p class="ew-status" role="status" data-ew-status></p><div data-ew-results></div><div class="ew-actions"><button type="button" data-ew-screening-map>Show screening results in 3D ↗</button><button type="button" data-ew-screening-hide>Hide model layer</button></div></div></details>';
  if(container)container.append(root);else if(doc.querySelector('#environmentStory')?.after)doc.querySelector('#environmentStory').after(root);else(doc.querySelector('#panel')||doc.body).append(root);
  if(doc.head&&!doc.getElementById('evidence-workbench-style')){const css=doc.createElement('link');css.id='evidence-workbench-style';css.rel='stylesheet';css.href=new URL('../css/evidence-workbench.css',import.meta.url).href;doc.head.append(css);}
  const form=root.querySelector('[data-ew-form]'),fieldHost=root.querySelector('[data-ew-fields]'),regionalHost=root.querySelector('[data-ew-regional]'),auditHost=root.querySelector('[data-ew-audit]'),resultHost=root.querySelector('[data-ew-results]'),variableSelect=root.querySelector('[data-ew-variable]');
  const fields=()=>{fieldHost.innerHTML=WORKBENCH_FIELDS[domain].map(([key,label,unit,min,max])=>`<label>${h(label)}${unit==='text'?'':` <small>${h(unit)}</small>`}<input name="${key}" type="${unit==='text'?'text':'number'}"${unit==='text'?' maxlength="80"':` min="${min}" max="${max}" step="any"`} value=""/></label>`).join('')+(['heat','air'].includes(domain)?'<label>Dispersion land use<select name="landUse"><option value="urban">Urban</option><option value="rural">Rural</option></select></label>'+note('Heat input means sensible heat released to air, not electrical capacity. Passive-tracer screening omits buoyancy and building effects.'):'')+(domain==='noise'?'<label>Chosen comparison levels (optional)<input name="noiseContours" type="text" placeholder="e.g. 40, 50, 60"/></label>'+note('These are chosen display contours, not health/legal limits. Sound power is different from sound pressure measured at a receptor.'):domain==='water'?note('Supply annual-average scenario flows with matching accounting boundaries. River flow means the receiving flow immediately before mixing, not a facility intake allowance or a peak permit rate.'):'');};
  const val=name=>form.elements?.namedItem(name)?.value||'';
  function paint(){
    if(destroyed)return;const variables=state.regional?.variables||[],existing=variables.some(v=>v.id===selectedVariable);
    const regionalSummary=root.querySelector('[data-ew-section="regional"] summary'),coverageSummary=root.querySelector('[data-ew-section="coverage"] summary');
    if(regionalSummary)regionalSummary.textContent=`Regional histories & trends${state.regional?` · ${variables.filter(v=>v.status==='available').length} ready`:''}`;
    if(coverageSummary){const counts=summarizeSiteAudit(state.audit);coverageSummary.textContent=`Source coverage & water gauges${state.audit?` · ${counts.observedStations} acquired gauge${counts.observedStations===1?'':'s'}`:''}`;}
    if(!existing)selectedVariable=variables.find(v=>v.status==='available')?.id||variables[0]?.id||'';
    const options=variables.map(v=>`<option value="${h(v.id)}"${v.id===selectedVariable?' selected':''}>${h(v.label)}${v.status==='available'?'':' · not imported'}</option>`).join('');
    if(variableSelect.innerHTML!==options)variableSelect.innerHTML=options;
    regionalHost.innerHTML=regionalEvidenceHtml(state.regional,{year:state.year,variable:selectedVariable});auditHost.innerHTML=siteAuditHtml(state.audit,state.year);
    resultHost.innerHTML=screeningResultsHtml(state.screening||localResult,state.year);
    root.querySelector('[data-ew-status]').textContent=error||status||(state.pending?state.status:'');
    for(const button of form.querySelectorAll('button'))button.disabled=pending||!!state.pending;
    root.querySelector('[data-ew-screening-map]').hidden=!(state.screening?.metrics?.length||localResult?.years?.some(r=>r.year===state.year&&r.metrics?.length));
    const hide=root.querySelector('[data-ew-screening-hide]');if(hide)hide.hidden=!state.showScreening;
  }
  function setState(next){if(destroyed||!next?.siteId||next.site?.id!==next.siteId)return;const changed=state.siteId!==next.siteId;
    // Moving the timeline wins over an earlier edit of the year box; progress updates
    // during a running calculation never overwrite what the user typed.
    if(next.year!==state.year&&!next.pending&&!pending)yearDirty=false;state=next;if(changed){requestToken++;pending=false;status=error='';localResult=null;yearDirty=false;selectedVariable='';form.reset();domain='heat';fields();}if(!yearDirty)form.elements.namedItem('year').value=String(next.year);paint();}
  async function run(missingOnly=false,yearOverride=null){
    if(pending||state.pending||destroyed)return;let payload;
    try{const values=Object.fromEntries(WORKBENCH_FIELDS[domain].map(([name])=>[name,val(name)]));if(domain==='noise')values.noiseContours=val('noiseContours');if(yearOverride){form.elements.namedItem('year').value=String(yearOverride);}
    payload=buildWorkbenchRequest({site:state.site,year:val('year'),domain,values,evidence:val('evidence'),citation:val('citation'),url:val('url'),landUse:val('landUse')||'urban',advancedJson:val('advancedJson'),span:yearOverride?'single':(val('span')||'single')},{missingOnly});}
    catch(cause){error=cause.message;paint();return;}
    const token=++requestToken,siteId=state.siteId;pending=true;error='';status='Calculating through the Node model service…';paint();
    try{if(!onRequest)throw new Error('The local model service is not connected. Start the local web server to calculate.');const response=await onRequest(payload);if(destroyed||token!==requestToken||state.siteId!==siteId)return;const result=response?.result||response;if(!Array.isArray(result?.years))throw new Error('The model service returned no completed screening result.');localResult=yearOverride&&localResult?.years?{...result,years:[...localResult.years.filter(r=>!result.years.some(n=>n.year===r.year)),...result.years].sort((a,b)=>a.year-b.year),requiredInputs:[...(localResult.requiredInputs||[]).filter(r=>!result.years.some(n=>n.year===r.year)),...(result.requiredInputs||[])]}:result;{const ys=localResult.years.map(r=>r.year);status=`Completed ${yearRanges(ys)} scenario. Same supplied inputs each year; source assumptions remain explicit.`;}}
    catch(cause){if(!destroyed&&token===requestToken)error=cause.message;}
    finally{if(!destroyed&&token===requestToken){pending=false;paint();}}
  }
  const submit=event=>{event.preventDefault();void run();};
  const click=event=>{const el=event.target.closest?.('button');if(!el||!root.contains(el))return;if(el.hasAttribute('data-ew-scenario-year')){const year=Number(el.getAttribute('data-ew-scenario-year'));if(Number.isInteger(year)&&year>=2003&&year<=2100){if(onSelectYear)onSelectYear(year);else eventTarget.CloudShadowTimeline?.setYear?.(year);}return;}if(el.hasAttribute('data-ew-missing'))void run(true);if(el.hasAttribute('data-ew-recalc-year')){const y=Number(el.getAttribute('data-ew-recalc-year'));if(validYear(y))void run(false,y);return;}if(el.hasAttribute('data-ew-water-map'))eventTarget.dispatchEvent(new CustomEvent('cs:audit-water-view',{detail:{siteId:state.siteId,year:state.year,readings:siteAuditWaterReadings(state.audit,state.year).filter(r=>r.available)}}));if(el.hasAttribute('data-ew-screening-hide'))eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{siteId:state.siteId,showScreening:false,screeningDomain:domain}}));if(el.hasAttribute('data-ew-screening-map'))eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{siteId:state.siteId,showScreening:true,screeningDomain:domain}}));};
  const change=event=>{if(event.target.hasAttribute('data-ew-variable')){selectedVariable=event.target.value;paint();}if(event.target.hasAttribute('data-ew-domain')){domain=event.target.value;fields();}if(event.target.name==='year')yearDirty=true;};
  const input=event=>{if(event.target.name==='year')yearDirty=true;};
  const update=({detail})=>setState(detail?.state);
  form.addEventListener('submit',submit);root.addEventListener('click',click);root.addEventListener('change',change);root.addEventListener('input',input);eventTarget.addEventListener('cs:future-state',update);
  fields();form.elements.namedItem('year').value=String(state.year??year);paint();
  return {setState,element:root,destroy(){destroyed=true;requestToken++;form.removeEventListener('submit',submit);root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('input',input);eventTarget.removeEventListener('cs:future-state',update);root.remove();}};
}
