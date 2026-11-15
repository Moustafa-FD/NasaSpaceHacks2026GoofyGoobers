// NASA POWER's projection service is an additional conditional climate product.
// It does not replace the five-model NEX-GDDP period summaries or observations.
export const POWER_PATHWAYS = Object.freeze({ssp126:'Low emissions · SSP1-2.6',ssp245:'Intermediate emissions · SSP2-4.5',ssp370:'High emissions · SSP3-7.0'});
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const days=(year,month)=>new Date(Date.UTC(year,month,0)).getUTCDate();

export function powerProjectionUrl(site){
  if(!finite(site?.lat)||!finite(site?.lon)||site.lat< -59.875||site.lat>89.875||site.lon< -179.875||site.lon>179.875)throw new Error('Location is outside NASA POWER projection coverage.');
  return 'https://power.larc.nasa.gov/api/projection/monthly/point?'+new URLSearchParams({parameters:'T2M,PRECTOTCORR',community:'AG',longitude:String(site.lon),latitude:String(site.lat),start:'201501',end:'210012',format:'JSON','time-standard':'UTC',model:'ensemble'});
}

export function normalizePowerProjection(raw,{site,sourceUrl=powerProjectionUrl(site),retrievedAt=new Date().toISOString()}={}){
  if(raw?.header?.temporal!=='monthly'||String(raw.header.time_standard).toLowerCase()!=='utc'||raw.parameters?.T2M?.units!=='C'||raw.parameters?.PRECTOTCORR?.units!=='mm/day')throw new Error('NASA projection units or calendar format are unsupported.');
  if(raw.header.model!=='ensemble')throw new Error('This annual view requires the NASA ensemble product.');
  const point=raw.geometry?.coordinates;
  if(!Array.isArray(point)||!finite(point[0])||!finite(point[1])||Math.abs(point[0]-site.lon)>.25||Math.abs(point[1]-site.lat)>.25)throw new Error('NASA projection returned a different or unknown location.');
  const parameters=raw.properties?.parameter;
  if(!parameters?.T2M||!parameters.PRECTOTCORR)throw new Error('NASA projection returned no usable variables.');
  const value=x=>finite(x)&&x!==raw.header.fill_value?x:null;
  const scenarios={};
  for(const scenario of Object.keys(POWER_PATHWAYS)){
    if(!parameters.T2M[scenario]&&!parameters.PRECTOTCORR[scenario])continue;
    const monthly=[],annual=[];
    for(let year=2015;year<=2100;year++){
      const rows=[];
      for(let month=1;month<=12;month++){
        const key=`${year}${String(month).padStart(2,'0')}`;
        const row={date:`${year}-${String(month).padStart(2,'0')}`,days:days(year,month),temperatureC:value(parameters.T2M[scenario]?.[key]),precipitationMmPerDay:value(parameters.PRECTOTCORR[scenario]?.[key])};
        monthly.push(row);rows.push(row);
      }
      const temperatureMonths=rows.filter(r=>finite(r.temperatureC)).length,precipitationMonths=rows.filter(r=>finite(r.precipitationMmPerDay)).length,totalDays=rows.reduce((n,r)=>n+r.days,0);
      annual.push({year,temperatureC:temperatureMonths===12?rows.reduce((n,r)=>n+r.temperatureC*r.days,0)/totalDays:null,precipitationMm:precipitationMonths===12?rows.reduce((n,r)=>n+r.precipitationMmPerDay*r.days,0):null,temperatureMonths,precipitationMonths});
    }
    scenarios[scenario]={label:POWER_PATHWAYS[scenario],monthly,annual};
  }
  if(!Object.keys(scenarios).length)throw new Error('NASA projection returned no supported emission pathways.');
  return {schemaVersion:'power-projection/1.0',site:{id:site.id,name:site.name,lat:site.lat,lon:site.lon},evidence:'climate-scenario',source:{name:'NASA POWER · NEX-GDDP-CMIP6',url:sourceUrl,documentation:'https://power.larc.nasa.gov/docs/services/api/projection/',retrievedAt,apiVersion:raw.header.api?.version},model:raw.header.model||'not supplied',resolution:'0.25° regional grid; nearest cell, no spatial interpolation',period:{start:2015,end:2100},scenarios,
    limitations:['Conditional climate simulations, not observations or weather forecasts for particular years.','The service ensemble output has no model-spread interval in this response.','Temperature is weighted by calendar-month length; annual precipitation sums monthly mean daily rates over calendar days.','Every annual value requires all 12 source months. Missing values remain unknown.','These pathways and ensemble differ from the existing five-model climate-period product. SSP3-7.0 is not SSP5-8.5.','Regional climate does not isolate a data center’s additional heat, emissions or water use.']};
}

export function powerProjectionYear(product,{year,scenario='ssp245'}={}){
  const record=product?.schemaVersion==='power-projection/1.0'?product.scenarios?.[scenario]?.annual?.find(row=>row.year===Number(year)):null;
  return {available:!!record&&(finite(record.temperatureC)||finite(record.precipitationMm)),year:Number(year),scenario,label:POWER_PATHWAYS[scenario],temperatureC:record?.temperatureC??null,precipitationMm:record?.precipitationMm??null,temperatureMonths:record?.temperatureMonths??0,precipitationMonths:record?.precipitationMonths??0,source:product?.source,model:product?.model,evidence:'climate-scenario',resolution:product?.resolution};
}

export async function fetchPowerProjection(site,{fetchImpl=globalThis.fetch,signal}={}){
  const url=powerProjectionUrl(site),response=await fetchImpl(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000),headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(`NASA projection source returned HTTP ${response.status}.`);
  const text=await response.text();if(text.length>4_000_000)throw new Error('NASA projection response exceeded the bounded size.');
  return normalizePowerProjection(JSON.parse(text),{site,sourceUrl:url});
}
