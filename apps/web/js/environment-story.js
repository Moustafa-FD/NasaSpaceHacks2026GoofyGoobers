import { STORY_VARIABLES, annualStorySeries, resolveStoryVariables, storyFormat, summarizeStoryMetric, summarizeStoryWater } from './environment-story-data.js';
import { isWaterUseRecord, resolveSiteEvidence } from './site-evidence.js';
import { summarizeFutureClimate, summarizeDailyClimateYear } from './future-data.js';
import {annualClimateHtml,climateModeControls} from './future-climate-view.js';

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const f = storyFormat;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const note = (text) => `<p class="est-note">${h(text)}</p>`;
function sourceLink(source) {
  try { const url = new URL(source?.url || source?.sourceUrl); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? `<a href="${h(url.href)}" target="_blank" rel="noopener noreferrer">${h(source.title || source.publisher || 'Source')} ↗</a>` : ''; } catch { return ''; }
}

/** The chart and value table use the same comparable observations. */
export function storyChartData(summary, mode = 'trend') {
  const observed = summary.annual.filter((p) => p.siteMonths || p.refMonths);
  const byYear = new Map(summary.annual.map((p) => [p.year, p]));
  const points = summary.annual.map((p) => {
    if (mode === 'year') return { year: p.year, site: p.pairedSite, ref: p.pairedRef };
    const window = [p.year - 2, p.year - 1, p.year].map((y) => byYear.get(y));
    return { year: p.year, site: window.every((v) => v && finite(v.local)) ? mean(window.map((v) => v.pairedSite)) : null, ref: window.every((v) => v && finite(v.local)) ? mean(window.map((v) => v.pairedRef)) : null };
  });
  const values = points.flatMap(p => [p.site,p.ref]).filter(finite);
  return {points,first:observed[0]?.year,last:observed.at(-1)?.year,values};
}

/** Readable source history. An unavailable future year never stretches the axis. */
export function storyChartSvg(summary, mode = 'trend', {expanded=false}={}) {
  const {points,first,last,values}=storyChartData(summary,mode);
  if(!values.length)return note('Not enough matching observations to draw this chart.');
  let low=Math.min(...values),high=Math.max(...values);
  const padding=Math.max((high-low)*.12,.001);low-=padding;high+=padding;
  const left=64,right=expanded?700:380,plotWidth=right-left;
  const x=year=>left+(year-first)/(last-first||1)*plotWidth,y=value=>210-(value-low)/(high-low)*178;
  const path = (field) => { let text = '', previous = null; for (const p of points) { if (!finite(p[field])) { previous = null; continue; } text += `${previous === p.year - 1 ? 'L' : 'M'}${x(p.year).toFixed(2)},${y(p[field]).toFixed(2)} `; previous = p.year; } return text; };
  const base = summary.baseline, onsetYear = summary.onsetYear, selected = points.find((p) => p.year === summary.year);
  const selectedX=x(summary.year),inRange=summary.year>=first&&summary.year<=last;
  const baselineStart=base.available?Math.max(left,x(base.start-.4)):left,baselineEnd=base.available?Math.min(right,x(base.end+.4)):left;
  const ticks=[...new Set([first,Math.round(first+(last-first)/3),Math.round(first+2*(last-first)/3),last])];
  return `<svg class="est-chart" viewBox="0 0 ${expanded?720:400} 260" role="img" tabindex="0" data-first-year="${first}" data-last-year="${last}" aria-label="${h(summary.meta.short)}: site and nearby ${mode === 'trend' ? 'trailing three-year means' : 'individual-year means'}, ${first} to ${last}, selected year ${summary.year}${inRange?'':', outside the observed record'}. Missing values are gaps. Click a year, or use left and right arrows to move the timeline.">
    <title>${h(summary.meta.short)} · ${h(summary.meta.unit)}</title>
    ${base.available?`<rect x="${baselineStart.toFixed(2)}" y="32" width="${Math.max(0,baselineEnd-baselineStart).toFixed(2)}" height="178" class="est-baseline"/>`:''}
    ${[0,1,2,3].map(i=>{const value=low+(high-low)*i/3;return `<line x1="${left}" y1="${y(value).toFixed(2)}" x2="${right}" y2="${y(value).toFixed(2)}" class="est-grid"/><text x="${left-9}" y="${(y(value)+5).toFixed(2)}" text-anchor="end" class="est-axis">${h(f(value,summary.meta.digits))}</text>`;}).join('')}
    ${onsetYear&&onsetYear>=first&&onsetYear<=last?`<line x1="${x(onsetYear).toFixed(2)}" x2="${x(onsetYear).toFixed(2)}" y1="32" y2="210" class="est-start"><title>Study comparison starts ${onsetYear}</title></line>`:''}
    <path d="${path('ref')}" class="est-line est-nearby"/><path d="${path('site')}" class="est-line est-site"/>
    ${inRange?`<line x1="${selectedX.toFixed(2)}" x2="${selectedX.toFixed(2)}" y1="32" y2="210" class="est-cursor"/>`:''}
    ${['site','ref'].map(field=>finite(selected?.[field])?`<circle cx="${selectedX.toFixed(2)}" cy="${y(selected[field]).toFixed(2)}" r="4.5" class="est-dot est-${field==='ref'?'nearby':'site'}"/>`:'').join('')}
    ${ticks.map(year=>`<text x="${x(year).toFixed(2)}" y="234" text-anchor="${year===first?'start':year===last?'end':'middle'}" class="est-axis">${year}</text>`).join('')}
    ${points.map(p=>{const step=plotWidth/(last-first||1),start=Math.max(left,x(p.year)-step/2);return `<rect data-story-year="${p.year}" x="${start.toFixed(2)}" y="32" width="${Math.max(0,Math.min(step,right-start)).toFixed(2)}" height="178" fill="transparent"><title>${p.year} · Site ${h(f(p.site,summary.meta.digits))}; nearby ${h(f(p.ref,summary.meta.digits))} ${h(summary.meta.unit)}</title></rect>`;}).join('')}
  </svg>`;
}

export function storyValuesHtml(summary,mode='trend'){
  const {points}=storyChartData(summary,mode);
  if(!points.some(p=>finite(p.site)||finite(p.ref)))return '';
  return `<details class="est-values-table"><summary>See all values</summary><div class="est-table-scroll"><table><caption>${h(summary.meta.short)} · ${h(summary.meta.unit)} · ${mode==='trend'?'3-year averages':'annual averages'}</caption><thead><tr><th scope="col">Year</th><th scope="col">Site</th><th scope="col">Nearby</th></tr></thead><tbody>${points.map(p=>`<tr${p.year===summary.year?' class="est-table-selected"':''}><th scope="row">${p.year}</th><td>${h(f(p.site,summary.meta.digits))}</td><td>${h(f(p.ref,summary.meta.digits))}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function storyMetricHtml(summary, mode = 'trend') {
  const { meta, baseline, selected, trailing, change, selectedChange } = summary, compare = mode === 'trend' ? change : selectedChange;
  if(summary.future)return `<div class="est-empty"><span class="est-status">${summary.year} · Beyond this record</span><h3>No ${h(meta.short.toLowerCase())} forecast</h3><p>${finite(summary.lastYear)?`Observations end in <strong>${summary.lastYear}</strong>.`:'No observations are loaded.'} Regional climate scenarios are available separately.</p><div class="est-actions">${finite(summary.lastYear)?`<button class="est-primary" type="button" data-story-year="${summary.lastYear}">View ${summary.lastYear} data</button>`:''}<button type="button" data-story-evidence="climate-projection">Climate scenarios ↗</button></div></div>`;
  const period = mode === 'trend' ? `${summary.year - 2}–${summary.year}` : String(summary.year);
  const chosenSite=mode==='trend'?trailing?.pairedSite:selected?.pairedSite,chosenRef=mode==='trend'?trailing?.pairedRef:selected?.pairedRef;
  const status=compare&&compare.local!==0&&baseline.years.length>=2?(compare.local>0?meta.higher:meta.higher==='adverse'?'favorable':'adverse'):'uncertain';
  return `<div class="est-measure-heading"><h3>${h(meta.short)}</h3><p>${period}${mode==='trend'?' · 3-year average':' · Annual average'}</p></div>
    <div class="est-values"><div><span>At the site</span><strong>${h(f(chosenSite,meta.digits))}</strong></div><div><span>Nearby area</span><strong>${h(f(chosenRef,meta.digits))}</strong></div></div><p class="est-unit">${h(meta.unit||'Index value')}</p>
    ${compare?`<div class="est-change est-${status}"><div><span>${meta.regional?'Regional change':'Local change'} since ${baseline.start}–${baseline.end}</span><strong>${h(f(compare.local,meta.digits,true))} <small>${h(meta.unit)}</small></strong></div><p>${meta.regional?'Regional climate context.':'Site change minus nearby change.'}${baseline.years.length<2?' One baseline year; uncertain.':''}</p></div>`:`<p class="est-gap">${!baseline.available?'Earlier baseline unavailable.':'Not enough matching observations for this window.'} No change estimate.</p>`}
    ${selected&&selected.pairedMonths<12?note(`Partial year · ${selected.pairedMonths}/12 matching months`):''}`;
}

export function storyMethodHtml(summary, mode = 'trend') {
  const { meta, baseline } = summary;
  const significance = summary.significance;
  return `<details class="est-method"><summary>Data &amp; method</summary>
    ${note(meta.source)}
    ${note(meta.meaning)}${note(summary.coverage)}
    ${baseline.available ? note(`Earlier baseline: ${baseline.years.join(', ')} (${baseline.years.length} available years). Up to five full calendar years before the comparison-start year; each needs at least nine matching months.`) : note(baseline.reason)}
    ${note(meta.regional ? 'This is regional climate context, not a local building signal.' : 'We subtract the nearby change from the site change to help separate local change from changes across the region. The comparison uses months available in both locations.')}
    ${mode === 'trend' ? note('Three-year view averages the selected year and the two years before it. One unusual year has less weight; later years are never included.') : note('One year can be unusually hot, wet or cloudy. Compare the three-year view before judging a longer change.')}
    ${note(summary.uncertainty)}
    ${significance ? note(`${significance.start || 'First source year'}–${significance.end || 'last source year'} whole-record test: ${significance.significant ? 'a statistically clear long-term trend' : 'no statistically clear long-term trend'} (${f(significance.slopePerDecade, meta.digits, true)} ${meta.unit} per decade; p=${f(significance.p, 3)}). This tests the whole record, not the selected-year baseline difference, and does not establish a facility effect.`) : note('No whole-record statistical test is attached to this view yet. Direction alone is not proof of a lasting change.')}
    ${note('Numbers are estimates decoded from NASA map colors. No values are inserted into missing months or years. The map uses a dated snapshot; this chart uses annual or three-year averages.')}
  </details>`;
}

export function storyWaterHtml(water, facility, year) {
  const allRecords = (facility?.water?.records || []).filter((r) => isWaterUseRecord(r) && finite(r.value) && r.unit && r.source?.url);
  const records = allRecords.filter((r) => r.year === year);
  const previousReport=allRecords.filter(r=>r.year<year).sort((a,b)=>b.year-a.year)[0];
  const recordHtml=r=>`<article class="est-water-record"><span>${h(r.metric==='reported-consumption'?'Reported consumption':'Reported water use')} · ${r.year}</span><strong>${h(r.approximation?r.approximation+' ':'')}${h(r.value>=1e6?f(r.value/1e6,3)+' million':f(r.value,0))}</strong><span>${h(r.unit)} · ${r.status==='reported-peak'?'reported peak rate · not a typical-day average':'annual total'}</span><details><summary>Source &amp; reporting scope</summary>${note(r.scope||'')}${note(r.note||'')}${sourceLink(r.source)}</details></article>`;
  return `<div class="est-measure-heading"><h3>Water</h3><p>${year} · Source-specific records</p></div>
    ${records.length?records.map(recordHtml).join(''):`<div class="est-empty"><h4>No reported facility total for ${year}</h4><p>Missing amounts stay unknown.</p>${previousReport?`<div class="est-actions"><button class="est-primary" type="button" data-story-year="${previousReport.year}">View ${previousReport.year} report</button></div>`:''}</div>`}
    ${water.soil||water.rain?`<div class="est-water-readings">${water.soil?`<div><span>Surface soil moisture</span><strong>${h(f(water.soil.value,3))} <small>${h(water.soil.unit)}</small></strong>${note(`${water.soil.days} returned days · not groundwater level`)}</div>`:''}${water.rain?`<div><span>Mean rainfall</span><strong>${h(f(water.rain.value,2))} <small>${h(water.rain.unit)}</small></strong>${note(`${water.rain.days} returned days`)}</div>`:''}</div>`:''}
    ${water.station?`<p class="est-station">${h(water.station.name||water.station.id)} · <strong>${water.station.numeric}</strong> numeric observations. Parameters and units remain separate.</p>`:''}
    <div class="est-actions"><button type="button" data-story-evidence="land-water">Soil &amp; rainfall ↗</button><button type="button" data-story-evidence="water-quality">Water-quality records ↗</button></div>
    ${allRecords.some(r=>r.year!==year)?`<details><summary>Reports from other years</summary>${allRecords.filter(r=>r.year!==year).map(recordHtml).join('')}</details>`:''}
    <details class="est-method"><summary>What these numbers mean</summary>${note('Reported use and reported consumption are different accounting measures. Neither is automatically evaporation. Totals are not spread across unreported years. Soil moisture is not groundwater level. A missing station record does not mean water is clean or polluted.')}</details>
    <p class="est-caveat">Groundwater depletion and river-level change are not modelled.</p>`;
}

const futureMetricNames = { meanTempC: 'Regional air temperature', hotDays35C: 'Very hot days · maximum ≥35°C', precipMmPerYear: 'Annual rainfall' };
const futureUnits = { meanTempC: '°C', hotDays35C: 'days / year', precipMmPerYear: 'mm / year' };
function futureProduct(future,kind){return future?.products?.[kind]||({ 'climate-projection':future?.climate, 'plume-scenario':future?.plume, agriculture:future?.agriculture, climate:future?.dailyClimate }[kind])?.result;}
function climateMetric(future,metric){
  const raw=futureProduct(future,'climate-projection');
  return raw?summarizeFutureClimate(raw,{year:future.year,scenario:future.scenario,metric}):future?.climate?.metrics?.[metric]||null;
}
function scenarioControls(future){
  const late=climateMetric(future,'meanTempC')?.period?.start===2081;
  return `<label class="est-measure">Emission pathway<select data-story-scenario><option value="ssp245"${future.scenario!=='ssp585'?' selected':''}>Intermediate emissions · SSP2-4.5</option><option value="ssp585"${future.scenario==='ssp585'?' selected':''}>Very high emissions · SSP5-8.5</option></select></label><div class="est-mode" role="group" aria-label="Climate period"><button type="button" data-story-year="2050" aria-pressed="${!late}">2041–2060</button><button type="button" data-story-year="2090" aria-pressed="${late}">2081–2100</button></div>`;
}
function climateCard(summary,metric){
  const unit=futureUnits[metric],digits=metric==='meanTempC'?1:0;
  if(!summary?.available||!finite(summary.value))return `<div class="est-gap">${h(futureMetricNames[metric])} is unavailable in this product.</div>`;
  return `<article class="est-future-card"><h3>${h(futureMetricNames[metric])}</h3><strong>${h(f(summary.value,digits))}<small>${unit}</small></strong><p>Model range <b>${h(f(summary.min,digits))} to ${h(f(summary.max,digits))}</b> ${unit}</p>${finite(summary.change?.median)?`<div class="est-future-change">${h(f(summary.change.median,digits,true))} ${unit}<span>change from 1995–2014 baseline</span></div>`:''}</article>`;
}
export function storyDailyClimateHtml(future,group){
  const raw=futureProduct(future,'climate'),metric=group==='water'?'precipMmPerYear':'meanTempC',unit=group==='water'?'mm / year':'°C',year=future.year;
  const summary=raw?summarizeDailyClimateYear(raw,{year,metric}):null,rows=(summary?.perModel||[]).map(r=>({model:r.model,value:r.value,count:r.validDays})),expected=summary?.perModel?.[0]?.expectedDays;
  return `${rows.length?`<details class="est-values-table"><summary>Daily climate model · ${year} summary</summary><div class="est-table-scroll"><table><caption>${group==='water'?'Annual rainfall':'Annual mean air temperature'} · ${unit} · ${h(summary.scenario||'source pathway not supplied')} · conditional model simulation</caption><thead><tr><th>Model</th><th>Value</th><th>Days</th></tr></thead><tbody>${rows.map(r=>`<tr><th scope="row">${h(r.model)}</th><td>${h(f(r.value,1))}</td><td>${r.count}/${expected}</td></tr>`).join('')}</tbody></table></div>${note('Only complete model years produce an annual number. These simulations do not forecast weather on specific future days. Models and scenario differ from the five-model CMIP6 period summaries above.')}</details>`:''}${year<=2049?`<button type="button" class="est-evidence-link" data-story-future-request="climate"${future.pending?' disabled':''}>${future.pending?'Calculating…':'Calculate daily climate model'} ↗</button>`:''}`;
}
export function storyClimateComparisonHtml(future,metric){
  const raw=futureProduct(future,'climate-projection'),unit=futureUnits[metric],digits=metric==='meanTempC'?1:0;
  if(!raw)return '';
  const mid=summarizeFutureClimate(raw,{year:2050,scenario:future.scenario,metric}),late=summarizeFutureClimate(raw,{year:2090,scenario:future.scenario,metric});
  const base=mid.baseline||late.baseline;
  const rows=[{label:'1995–2014 · baseline',value:base?.value,min:base?.min,max:base?.max},...[[mid,'2041–2060'],[late,'2081–2100']].map(([s,label])=>({label,value:s?.value,min:s?.min,max:s?.max,selected:s?.period?.start===climateMetric(future,metric)?.period?.start}))];
  return `<details class="est-values-table"><summary>Compare climate periods</summary><div class="est-table-scroll"><table><caption>${h(futureMetricNames[metric])} · ${unit} · model median and range</caption><thead><tr><th scope="col">Period</th><th scope="col">Median</th><th scope="col">Range</th></tr></thead><tbody>${rows.map(r=>`<tr${r.selected?' class="est-table-selected"':''}><th scope="row">${r.label}</th><td>${h(f(r.value,digits))}</td><td>${h(f(r.min,digits))}–${h(f(r.max,digits))}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function futureClimateHtml(group,future){
  if(future.climateView==='annual'&&future.products?.['power-projection'])return annualClimateHtml(future,group);
  const metric=group==='water'?'precipMmPerYear':'meanTempC',summary=climateMetric(future,metric),raw=futureProduct(future,'climate-projection');
  return `${climateModeControls(future)}${scenarioControls(future)}${summary?.available?`<p class="est-future-period">${h(summary.period?.label||`${summary.period?.start}–${summary.period?.end}`)} · regional climate scenario</p>${climateCard(summary,metric)}${group==='heat'?climateCard(climateMetric(future,'hotDays35C'),'hotDays35C'):''}${storyClimateComparisonHtml(future,metric)}<button type="button" class="est-evidence-link" data-story-future-map>Show scenario in 3D ↗</button><details class="est-method"><summary>Source &amp; model range</summary>${note(raw?.source?.name||summary.source?.name||'NASA NEX-GDDP-CMIP6')}${note(raw?.evidenceNote||'Conditional regional climate scenario. The range is model spread, not a confidence interval.')}${note(raw?.sampling?.note||'This is a period summary, not a forecast of a particular calendar year.')}${sourceLink({url:raw?.source?.access,title:'Climate source'})}</details>`:`<div class="est-empty"><h3>Loading regional climate scenarios</h3><p>${h(future.error||'Prepared Python model results load automatically for the study areas.')}</p><div class="est-actions"><button type="button" data-story-future-request="climate-projection"${future.pending?' disabled':''}>${future.pending?'Calculating…':'Calculate climate scenario'}</button></div></div>`}${storyDailyClimateHtml(future,group)}<p class="est-caveat">${group==='water'?'Rainfall is climate context. River levels, groundwater depletion and water quality are not predicted.':'Regional air temperature does not isolate heat produced by the data center.'} Values summarize the labelled period, not the selected individual year.</p>`;
}
function futureAirHtml(future){
  const raw=futureProduct(future,'plume-scenario'),peak=raw?.peak,height=raw?.assumptions?.effectiveStackHeightM;
  const hasSourcedEmission=finite(raw?.emission?.rateGs)&&raw.emission.rateGs>0&&typeof raw.emission.source==='string'&&!!raw.emission.source.trim();
  const hasConcentration=hasSourcedEmission&&finite(peak?.concentrationUgM3)&&peak.concentrationUgM3>=0;
  const dilutionUnit=raw?.grid?.units==='s/m^3'?'s/m³':raw?.grid?.units||'unit not supplied';
  const unit=hasConcentration?'µg/m³':`${dilutionUnit} · χ/Q`;
  const receptorValue=r=>hasConcentration?(finite(r.concentrationUgM3)&&r.concentrationUgM3>=0?f(r.concentrationUgM3,2):'Unknown'):(finite(r.chiOverQ)?r.chiOverQ.toExponential(2):'Unknown');
  const receptorTable=raw?.receptors?.length?`<details class="est-values-table"><summary>Nearby receptor values</summary><div class="est-table-scroll"><table><caption>${hasConcentration?'Source-only concentration · µg/m³':`Dilution per unit emission · ${h(dilutionUnit)}`}</caption><thead><tr><th>Location</th><th>${hasConcentration?'Contribution':'χ/Q'}</th></tr></thead><tbody>${raw.receptors.map(r=>`<tr><th scope="row">${h(r.name)}</th><td>${h(receptorValue(r))}</td></tr>`).join('')}</tbody></table></div></details>`:'';
  return `<div class="est-measure-heading"><h3>Air dispersion scenario</h3><p>Conditional screening · not an annual air-quality forecast</p></div>${raw?`<article class="est-future-card"><h3>${hasConcentration?'Peak source contribution':'Peak dilution per unit emission'}</h3><strong>${hasConcentration?h(f(peak.concentrationUgM3,2)):finite(peak?.chiOverQ)?h(peak.chiOverQ.toExponential(2)):'Unknown'}<small>${h(unit)}</small></strong><p>${finite(peak?.distanceM)?`${h(f(peak.distanceM,0))} m from the source`:'Source footprint'} · assumed effective stack ${h(f(height,0))} m</p></article><button type="button" class="est-primary" data-story-future-map>Show dispersion in 3D ↗</button>${receptorTable}<details class="est-method"><summary>Inputs &amp; limitations</summary>${note(raw.evidenceNote)}${note(`Wind record: ${raw.frames?.first||'unknown'} to ${raw.frames?.last||'unknown'}. This footprint uses those winds; moving the future year does not create future weather.`)}${note(hasSourcedEmission?`Emission rate: ${raw.emission.rateGs} g/s. Source: ${raw.emission.source}`:'No sourced emission rate supplied. Dilution is not a measured pollution concentration.')}</details>`:`<div class="est-empty"><h4>Calculate a dispersion scenario</h4><p>Use the Node → Python model with an explicitly assumed 20 m effective stack and analysed winds.</p><div class="est-actions"><button type="button" class="est-primary" data-story-future-request="plume-scenario"${future.pending?' disabled':''}>${future.pending?'Calculating…':'Calculate dispersion'}</button></div></div>`}<p class="est-caveat">This shows where emissions could spread under the stated inputs. It does not predict changes in emissions or future background air quality.</p>`;
}
function futureAgricultureHtml(future){
  const raw=futureProduct(future,'agriculture'),fields=[['meanTemperatureC','Growing-season temperature','°C'],['heatThresholdDays','Very hot days','days / season'],['dryThresholdDays','Dry days','days / season'],['precipitationMinusReferenceEt0Mm','Rain minus reference evaporation','mm / season']];
  const start=Number(raw?.futurePeriod?.start?.slice(0,4)),end=Number(raw?.futurePeriod?.end?.slice(0,4)),covered=raw&&future.year>=start&&future.year<=end;
  return `<div class="est-measure-heading"><h3>Agricultural climate exposure</h3><p>Heat, dryness and growing-season conditions</p></div>${raw?`<p class="est-future-period">Model period ${h(raw.futurePeriod?.start)} to ${h(raw.futurePeriod?.end)}</p>${!covered?note(`This result covers ${start}–${end}, not ${future.year}.`):''}${raw.comparisons?.map(model=>`<section class="est-agriculture-model"><h4>${h(model.model)}</h4>${fields.filter(([id])=>model.indicators?.[id]).map(([id,label,unit])=>{const row=model.indicators[id];return `<article class="est-future-mini"><span>${label}</span><strong>${h(f(row.futureMeanPerSeason,1))} <small>${unit}</small></strong><p>${h(f(row.change,1,true))} vs baseline · baseline ${h(f(row.baselineMeanPerSeason,1))}</p></article>`;}).join('')}</section>`).join('')||note('No complete model seasons were returned. Missing values stay unknown.')}<button type="button" class="est-evidence-link" data-story-future-map>Show exposure in 3D ↗</button><details class="est-method"><summary>Inputs &amp; thresholds</summary>${note(`Baseline ${raw.baselinePeriod?.start} to ${raw.baselinePeriod?.end}. Growing months ${(raw.settings?.growingMonths||[]).join(', ')}. Hot-day threshold ${raw.settings?.heatThresholdC}°C; dry-day threshold ${raw.settings?.dryDayThresholdMm} mm.`)}${(raw.warnings||[]).map(note).join('')}</details>`:''}${!covered?`<div class="est-actions">${future.year<=2049?`<button type="button" class="est-primary" data-story-future-request="agriculture"${future.pending?' disabled':''}>${future.pending?'Calculating…':'Calculate climate exposure'}</button>`:`<button type="button" data-story-year="2049">Explore supported 2045–2049 period</button>`}</div>`:''}<p class="est-caveat">${future.year>2049?'This agricultural model ends in 2049. ':''}Climate exposure does not predict crop yield, forest death or damage caused by a data center.</p>`;
}
/** Actual future products remain separate from the observed annual chart. */
export function storyFutureHtml(group,future={},variable){
  const status=future.pending||future.error||future.status;
  const trend=future.trend?.variables?.[variable],meta=STORY_VARIABLES[variable];
  const trendHtml=trend?.available&&finite(trend.value)&&future.year===trend.year?`<article class="est-trend-card"><span class="est-status">If the historical trend continues · ${future.year}</span><h3>${h(meta?.short||variable)}</h3><strong>${h(f(trend.value,meta?.digits||2))} <small>${h(meta?.unit||trend.unit)}</small></strong>${finite(trend.min)&&finite(trend.max)?note(`Trend-slope interval: ${f(trend.min,meta?.digits||2)} to ${f(trend.max,meta?.digits||2)} ${meta?.unit||trend.unit||''}. This is not a prediction interval.`):''}${finite(trend.local)?note(`Site minus nearby: ${f(trend.local,meta?.digits||2,true)} ${meta?.unit||trend.unit||''}.`):''}${note('Extrapolation through 2035 only; it assumes the observed trend continues. It does not establish a data-center effect.')}</article>`:'';
  return `<section class="est-future" aria-label="Supported future model results"><span class="est-status">Future model results</span>${status?`<p class="est-future-status" role="status">${h(future.error||future.status||(future.pending?'Calculating model results…':''))}</p>`:''}${trendHtml}${group==='heat'||group==='water'?futureClimateHtml(group,future):group==='air'?futureAirHtml(future):futureAgricultureHtml(future)}</section>`;
}

export function attachEnvironmentStory({ site, sites = [], seriesBySite = {}, varId = 'LST_Day', year = 2025, futureState, onSelectVariable, onSelectYear, onOpenEvidence, container, eventTarget = globalThis.window, document: doc = globalThis.document, evidenceResolver } = {}) {
  const initial = site || sites[0] || eventTarget?.CloudShadow?.state?.site;
  if (!doc || !eventTarget) throw new Error('The environmental story needs a document and event target.');
  const state = { site: initial, year, variable: STORY_VARIABLES[varId] ? varId : 'LST_Day', activeGroup: STORY_VARIABLES[varId]?.group || 'heat', mode: 'trend', analyses: new Map(), observations: new Map(), waterResults: new Map(), facility: null, future:futureState||null, futureStates:new Map(futureState?.siteId?[[futureState.siteId,futureState]]:[]), destroyed: false };
  const resolveEvidence = evidenceResolver || resolveSiteEvidence;
  const root = doc.createElement('section'); root.id = 'environmentStory'; root.className = 'environment-story'; root.setAttribute('aria-label', 'What changed here environmental evidence');
  let chartDialog=null;
  if (container) container.append(root); else { const story = doc.querySelector('#story'); if (story?.after) story.after(root); else (doc.querySelector('#panel') || doc.body).append(root); }
  const vars = () => { const raw = seriesBySite[state.site?.id] || {}; return { ...(raw.vars || raw), ...state.observations.get(state.site?.id) }; };
  const summary = (variable) => summarizeStoryMetric(vars()[variable], state.site, variable, state.year, state.analyses.get(`${state.site?.id}:${variable}`));
  const water = () => summarizeStoryWater([...state.waterResults.values()], state.year);
  function publishView() { eventTarget.dispatchEvent(new CustomEvent('cs:future-view',{detail:{group:state.activeGroup,siteId:state.site?.id,year:state.year}})); if (state.activeGroup !== 'water') eventTarget.dispatchEvent(new CustomEvent('cs:story-view', { detail: { mode: state.mode, variable: state.variable, siteId: state.site?.id, year: state.year, windowYears: 3 } })); }
  function refreshFacility() { if (resolveEvidence && state.site?.id) { try { state.facility = resolveEvidence(state.site.id, state.year); } catch { state.facility = null; } } }
  function openEvidence(action) { if (onOpenEvidence) onOpenEvidence(action); else eventTarget.CloudShadow?.environment?.openAction?.(action); }
  function chartSection(focus,expanded=false){
    const wide=expanded&&(doc.documentElement?.clientWidth||eventTarget.innerWidth||720)>680;
    return `<section class="est-chart-section"><div class="est-chart-heading"><h4>Change over time</h4>${expanded?'':'<button type="button" data-story-expand>Expand chart ↗</button>'}</div><p class="est-chart-unit">${h(focus.meta.unit)} · ${state.mode==='trend'?'3-year averages':'Annual averages'}</p><div class="est-chart-legend"><span class="est-site">Site</span><span class="est-nearby">Nearby area</span></div>${storyChartSvg(focus,state.mode,{expanded:wide})}<p class="est-chart-help">Click a year to inspect it. Gaps mean missing data.</p></section>`;
  }
  function updateDialog(){
    if(!chartDialog?.open)return;
    if(state.year>new Date().getUTCFullYear()||summary(state.variable).future){chartDialog.close();return;}
    const focus=summary(state.variable),body=chartDialog.querySelector('.est-dialog-body');
    const restore=doc.activeElement?.classList?.contains('est-chart');
    chartDialog.querySelector('.est-dialog-title').textContent=`${focus.meta.short} · ${state.site?.name||'Selected location'}`;
    body.innerHTML=storyMetricHtml(focus,state.mode)+chartSection(focus,true)+`<p class="est-source">${focus.meta.regional?'Regional model estimate':'Satellite estimate'} · ${h(focus.meta.source)}</p>`+storyValuesHtml(focus,state.mode);
    if(restore)body.querySelector('.est-chart')?.focus();
  }
  function expandChart(){
    if(doc.querySelector?.('#tlPlay')?.getAttribute('aria-label')==='Pause timeline')eventTarget.CloudShadowTimeline?.togglePlay();
    if(!chartDialog){
      chartDialog=doc.createElement('dialog');chartDialog.className='est-chart-dialog';chartDialog.setAttribute('aria-labelledby','estDialogTitle');
      chartDialog.innerHTML='<header><h2 id="estDialogTitle" class="est-dialog-title"></h2><button type="button" data-story-close aria-label="Close expanded chart">Close ×</button></header><div class="est-dialog-body"></div>';
      chartDialog.addEventListener('click',click);chartDialog.addEventListener('keydown',key);
      chartDialog.addEventListener('close',()=>root.querySelector('[data-story-expand]')?.focus());
      doc.body.append(chartDialog);
    }
    chartDialog.showModal();updateDialog();
  }
  function render() {
    if (state.destroyed) return;
    const focus=summary(state.variable),w=water(),measurements=Object.entries(STORY_VARIABLES).filter(([,meta])=>meta.group===state.activeGroup);
    const futureMode=state.activeGroup==='water'?state.year>new Date().getUTCFullYear():focus.future;
    const future={...(state.future?.siteId===state.site?.id?state.future:{}),siteId:state.site?.id,year:state.year};
    root.innerHTML=`<header class="est-header"><div><h2>Environment</h2><p>${h(state.site?.name||'Selected location')}</p></div><span class="est-year">${state.year}</span></header>
      <nav class="est-categories" aria-label="Environmental category">${[['air','Air'],['vegetation','Vegetation'],['heat','Heat'],['water','Water']].map(([group,title])=>`<button type="button" data-story-group="${group}" aria-pressed="${state.activeGroup===group}">${title}</button>`).join('')}</nav>
      ${futureMode?storyFutureHtml(state.activeGroup,future,state.variable):state.activeGroup==='water'?storyWaterHtml(w,state.facility,state.year):`<div class="est-selected">
      ${measurements.length>1?`<label class="est-measure">Measurement<select data-story-variable>${measurements.map(([id,meta])=>`<option value="${id}"${id===state.variable?' selected':''}>${h(meta.label)}</option>`).join('')}</select></label>`:''}
      ${!focus.future?`<div class="est-mode" role="group" aria-label="Time comparison"><button type="button" data-story-mode="year" aria-pressed="${state.mode==='year'}">One year</button><button type="button" data-story-mode="trend" aria-pressed="${state.mode==='trend'}">3-year average</button></div>`:''}
      ${storyMetricHtml(focus,state.mode)}
      ${!focus.future?`${chartSection(focus)}<p class="est-source">${focus.meta.regional?'Regional model estimate':'Satellite estimate'} · ${h(focus.meta.source)}</p>${storyValuesHtml(focus,state.mode)}`:''}
      ${storyMethodHtml(focus,state.mode)}
      ${state.activeGroup==='air'?'<button type="button" class="est-evidence-link" data-story-evidence="air-quality">Near-surface air records ↗</button>':''}
      <p class="est-caveat">Nearby change does not prove a data center caused it.</p></div>`}`;
    updateDialog();
  }
  function setSite(next) { if (!next?.id) return; state.site = next; state.future=state.futureStates.get(next.id)||null; state.waterResults.clear(); state.facility = null; refreshFacility(); render(); publishView(); }
  function setYear(value) { if (!finite(value) || state.year === Math.round(value)) return; state.year = Math.round(value); refreshFacility(); render(); publishView(); }
  function setVariable(value) { if (!STORY_VARIABLES[value]) return; state.variable = value; state.activeGroup = STORY_VARIABLES[value].group; render(); publishView(); }
  function setFutureState(value){if(!value?.siteId||state.destroyed)return;state.futureStates.set(value.siteId,value);if(state.futureStates.size>8)state.futureStates.delete(state.futureStates.keys().next().value);if(value.siteId===state.site?.id){state.future=value;render();}}
  function setAnalysis(variable, analysis, siteId = state.site?.id) {
    if (!analysis || !STORY_VARIABLES[variable]) return;
    state.analyses.set(`${siteId}:${variable}`, analysis); if (state.analyses.size > 40) state.analyses.delete(state.analyses.keys().next().value);
    // The app also emits actual sampled arrays for click-anywhere locations.
    // Retain them without modifying the parent's prepared case-study dataset.
    if (Array.isArray(analysis.t) && Array.isArray(analysis.site) && Array.isArray(analysis.ref)) {
      state.observations.set(siteId, { ...state.observations.get(siteId), [variable]: { t: analysis.t, site: analysis.site, ref: analysis.ref } });
      if (state.observations.size > 8) state.observations.delete(state.observations.keys().next().value);
    }
    if (siteId === state.site?.id) render();
  }
  function setWaterEvidence(result) { if (!['land-water', 'water-quality'].includes(result?.kind)) return; state.waterResults.set(result.kind, result); render(); }
  function selectYear(value) { const next = Math.round(Number(value)); if (!Number.isFinite(next)) return; if (onSelectYear) onSelectYear(next); else eventTarget.CloudShadowTimeline?.setYear?.(next); if (state.year !== next) setYear(next); }
  const click = (event) => {
    const el = event.target.closest?.('[data-story-group],[data-story-mode],[data-story-year],[data-story-evidence],[data-story-expand],[data-story-close],[data-story-future-request],[data-story-future-map],[data-climate-view]'); if (!el || !(root.contains(el)||chartDialog?.contains(el))) return;
    if(el.hasAttribute('data-climate-view')){eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{climateView:el.dataset.climateView,showScreening:false}}));return;}
    if(el.hasAttribute('data-story-expand')){expandChart();return;}
    if(el.hasAttribute('data-story-close')){chartDialog?.close();return;}
    if(el.hasAttribute('data-story-future-request')){eventTarget.dispatchEvent(new CustomEvent('cs:future-request',{detail:{kind:el.dataset.storyFutureRequest,siteId:state.site?.id,year:state.year}}));return;}
    if(el.hasAttribute('data-story-future-map')){eventTarget.dispatchEvent(new CustomEvent('cs:future-view',{detail:{group:state.activeGroup,siteId:state.site?.id,year:state.year,enabled:true}}));return;}
    if (el.dataset.storyGroup) { const group = el.dataset.storyGroup; state.activeGroup = group; if (group !== 'water') { state.variable = resolveStoryVariables(vars(), state.variable)[group]; onSelectVariable?.(state.variable); } render(); publishView(); }
    else if (el.dataset.storyMode) { state.mode = el.dataset.storyMode; render(); publishView(); }
    else if (el.dataset.storyYear) selectYear(el.dataset.storyYear);
    else if (el.dataset.storyEvidence) openEvidence(el.dataset.storyEvidence);
  };
  const change = (event) => { if(event.target.hasAttribute('data-power-scenario')){eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{powerScenario:event.target.value,showScreening:false}}));return;}  if(event.target.hasAttribute('data-story-scenario')){eventTarget.dispatchEvent(new CustomEvent('cs:future-options',{detail:{scenario:event.target.value}}));return;} if (!event.target.hasAttribute('data-story-variable')) return; setVariable(event.target.value); onSelectVariable?.(state.variable); publishView(); };
  const key = (event) => { if (!event.target.classList?.contains('est-chart') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); selectYear(state.year + (event.key === 'ArrowRight' ? 1 : -1)); (chartDialog?.open?chartDialog:root).querySelector('.est-chart')?.focus(); };
  const onSite = ({ detail }) => { if (detail?.site) setSite(detail.site); };
  const onYear = ({ detail }) => { if (detail?.year && (!detail.siteId || detail.siteId === state.site?.id)) setYear(detail.year); };
  const onLayer = ({ detail }) => { if (STORY_VARIABLES[detail?.kind]) setVariable(detail.kind); };
  const onAnalysis = ({ detail }) => { if (detail) setAnalysis(detail.varId || detail.variable, detail.analysis, detail.siteId); };
  const onData = ({ detail }) => { if (detail?.siteId === state.site?.id) setWaterEvidence(detail.result); };
  const onFuture=({detail})=>setFutureState(detail?.state);
  const onFacility = ({ detail }) => { if (detail?.siteId === state.site?.id && Number(detail.year) === state.year) { state.facility = detail; render(); } };
  const onResize=()=>updateDialog();
  root.addEventListener('click', click); root.addEventListener('change', change); root.addEventListener('keydown', key);
  const listeners = [['cs:site', onSite], ['cs:location', onSite], ['cs:year', onYear], ['cs:map-layer', onLayer], ['cs:analysis', onAnalysis], ['cs:environment-data', onData], ['cs:future-state',onFuture], ['cs:facility-evidence', onFacility],['resize',onResize]];
  for (const [type, listener] of listeners) eventTarget.addEventListener(type, listener);
  refreshFacility(); render(); publishView();
  return { setSite, setYear, setVariable, setAnalysis, setWaterEvidence, setFutureState, get state() { return state; }, destroy() { state.destroyed = true; for (const [type, listener] of listeners) eventTarget.removeEventListener(type, listener);if(chartDialog){if(chartDialog.open)chartDialog.close();chartDialog.remove();} root.remove(); } };
}
