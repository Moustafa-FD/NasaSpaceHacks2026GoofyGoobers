// Presentation only: never changes scientific timeline phases or wind forcing.
import {POWER_PATHWAYS} from './power-projection.js';
const finite=value=>typeof value==='number'&&Number.isFinite(value);

/** Accept only the selected site/year's explicitly selected annual simulation. */
export function futureTimelineSummary(state,{siteId,year,currentYear=new Date().getUTCFullYear()}={}){
  const power=state?.power;
  if(state?.siteId!==siteId||state?.year!==year||state?.climateView!=='annual'||!finite(year)||year<=currentYear||!power?.available||power.year!==year)return null;
  const chips=[];
  if(finite(power.temperatureC))chips.push({label:'Regional air',value:power.temperatureC,digits:1,unit:'°C'});
  if(finite(power.precipitationMm))chips.push({label:'Regional precipitation',value:power.precipitationMm,digits:0,unit:'mm/year'});
  if(!chips.length)return null;
  const pathway=POWER_PATHWAYS[power.scenario]||'Source emission pathway';
  return {badge:'CLIMATE SIMULATION · ANNUAL',chips,pathway,
    aria:`${year}, annual regional climate simulation; ${pathway}; not observed weather or an annual facility-impact prediction`,
    trendText:`${year} · site history; annual regional data above`,
    trendTitle:'This graph retains site-minus-surroundings history and trend continuations through 2035. Annual regional climate simulation values appear above; they are not future local site-minus-surroundings values.',
    zone:'Future · annual climate simulation'};
}
