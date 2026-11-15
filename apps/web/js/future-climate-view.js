import {POWER_PATHWAYS,powerProjectionYear} from './power-projection.js';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,d=1)=>finite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'Unknown';
export function climateModeControls(future){
  if(!future.products?.['power-projection'])return '';
  return `<div class="est-mode" role="group" aria-label="Climate model view"><button type="button" data-climate-view="annual" aria-pressed="${future.climateView==='annual'}">Yearly simulation</button><button type="button" data-climate-view="period" aria-pressed="${future.climateView!=='annual'}">Climate periods</button></div>`;
}
export function annualClimateChart(product,{year,scenario='ssp245',group='heat'}={}){
  const key=group==='water'?'precipitationMm':'temperatureC',unit=group==='water'?'mm/year':'°C',rows=product?.scenarios?.[scenario]?.annual||[],valid=rows.filter(r=>finite(r[key]));
  if(!valid.length)return '<p>No complete model years are available.</p>';
  const min=Math.min(...valid.map(r=>r[key])),max=Math.max(...valid.map(r=>r[key])),padding=Math.max((max-min)*.12,.1),lo=min-padding,hi=max+padding;
  const x=y=>57+(y-2015)/85*310,y=v=>169-(v-lo)/(hi-lo)*126;
  let path='',pen=false;
  for(const row of rows){if(!finite(row[key])){pen=false;continue;}path+=`${pen?'L':'M'}${x(row.year).toFixed(2)},${y(row[key]).toFixed(2)} `;pen=true;}
  const ticks=[lo,(lo+hi)/2,hi],selected=rows.find(r=>r.year===year);
  return `<svg class="est-annual-chart" viewBox="0 0 400 230" role="img" aria-label="NASA POWER ${h(unit)} annual climate simulation, 2015 to 2100. Selected year ${year}. Gaps mean missing months.">${ticks.map(t=>`<path d="M57 ${y(t)}H367" stroke="#739398" stroke-opacity=".2"/><text x="48" y="${y(t)+5}" text-anchor="end">${number(t,group==='water'?0:1)}</text>`).join('')}<path d="${path}" fill="none" stroke="#8ad4c3" stroke-width="3"/>${[2015,2040,2070,2100].map(t=>`<text x="${x(t)}" y="198" text-anchor="middle">${t}</text>`).join('')}${finite(selected?.[key])?`<path d="M${x(year)} 30V169" stroke="#f3b47c"/><circle cx="${x(year)}" cy="${y(selected[key])}" r="5" fill="#f3b47c"/>`:''}<text x="57" y="220">${h(unit)} · one conditional model pathway</text></svg>`;
}
export function annualClimateHtml(future,group){
  const product=future.products?.['power-projection'];if(!product)return '';
  const scenario=future.powerScenario||'ssp245',row=powerProjectionYear(product,{year:future.year,scenario}),water=group==='water',value=water?row.precipitationMm:row.temperatureC,unit=water?'mm / year':'°C';
  return `${climateModeControls(future)}<label class="est-measure">Annual simulation pathway<select data-power-scenario>${Object.entries(POWER_PATHWAYS).map(([id,label])=>`<option value="${id}"${id===scenario?' selected':''}>${label}</option>`).join('')}</select></label><article class="est-future-card"><h3>${future.year} · ${water?'Annual precipitation':'Regional air temperature'}</h3><strong>${number(value,water?0:1)}<small>${unit}</small></strong><p>NASA ensemble simulation · ${water?row.precipitationMonths:row.temperatureMonths}/12 source months</p></article>${annualClimateChart(product,{year:future.year,scenario,group})}<p class="est-chart-help">A simulated climate year can vary naturally. Use climate periods to compare long-term change and model spread.</p><details class="est-values-table"><summary>Annual values</summary><div class="est-table-scroll"><table><caption>NASA POWER · ${h(POWER_PATHWAYS[scenario])}</caption><thead><tr><th>Year</th><th>Temperature °C</th><th>Precipitation mm/year</th></tr></thead><tbody>${product.scenarios?.[scenario]?.annual?.map(r=>`<tr${r.year===future.year?' class="est-table-selected"':''}><th scope="row"><button type="button" data-story-year="${r.year}">${r.year}</button></th><td>${number(r.temperatureC)}</td><td>${number(r.precipitationMm,0)}</td></tr>`).join('')||''}</tbody></table></div></details><details class="est-method"><summary>Source &amp; model meaning</summary><p>${h(product.resolution)}</p>${(product.limitations||[]).map(note=>`<p>${h(note)}</p>`).join('')}<a href="https://power.larc.nasa.gov/docs/services/api/projection/" target="_blank" rel="noopener noreferrer">NASA projection methods ↗</a></details>`;
}
