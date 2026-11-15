// Source-specific regional histories. No historical value is carried forward
// into an unavailable year, and a source grid is never a facility footprint.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validId=id=>typeof id==='string'&&/^[a-z0-9_-]{1,80}$/i.test(id);

export function validateRegionalEvidence(product,siteId){
  if(product?.schemaVersion!=='regional-evidence/1.0'||product.site?.id!==siteId||!finite(product.site?.lat)||!finite(product.site?.lon)||!Array.isArray(product.variables)||product.variables.length>32||!Array.isArray(product.inventory)||product.inventory.length>64)throw new Error('Invalid regional evidence product.');
  const ids=new Set();
  for(const variable of product.variables){
    if(!validId(variable?.id)||ids.has(variable.id)||!Array.isArray(variable.monthly)||variable.monthly.length>2400||!Array.isArray(variable.annual)||variable.annual.length>200||typeof variable.unit!=='string'||typeof variable.annualUnit!=='string')throw new Error('Invalid regional evidence variable.');
    ids.add(variable.id);
    let previous='';
    for(const row of variable.monthly){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.date)||row.date<=previous||!(row.value===null||finite(row.value)))throw new Error('Invalid regional monthly sequence.');previous=row.date;}
    let lastYear=0;
    for(const row of variable.annual){if(!Number.isInteger(row.year)||row.year<1900||row.year>2200||row.year<=lastYear||!(row.value===null||finite(row.value))||!Number.isInteger(row.validMonths)||row.validMonths<0||row.validMonths>12)throw new Error('Invalid regional annual sequence.');lastYear=row.year;}
  }
  return product;
}

export function createRegionalEvidenceLoader({fetchImpl=globalThis.fetch,dataBase='data',cacheLimit=8}={}){
  const cache=new Map();
  return {async load(siteId,{signal}={}){
    if(!validId(siteId))throw new Error('Invalid regional evidence site.');
    if(signal?.aborted)throw new DOMException('Regional evidence load stopped.','AbortError');
    if(cache.has(siteId))return cache.get(siteId);
    const response=await fetchImpl(`${dataBase}/regional-evidence/${siteId}.json`,{signal});
    if(!response.ok)throw new Error(response.status===404?'No prepared regional evidence for this place.':`Regional evidence HTTP ${response.status}`);
    const length=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(length)&&length>2*1024*1024)throw new Error('Regional evidence product is too large.');
    const product=validateRegionalEvidence(await response.json(),siteId);
    if(signal?.aborted)throw new DOMException('Regional evidence load stopped.','AbortError');
    cache.set(siteId,product);while(cache.size>cacheLimit)cache.delete(cache.keys().next().value);
    return product;
  },clear(){cache.clear();},get size(){return cache.size;}};
}
const sharedLoader=createRegionalEvidenceLoader();
export function loadRegionalEvidence(siteId,options={}){
  if(options.fetchImpl||options.dataBase)return createRegionalEvidenceLoader(options).load(siteId,options);
  return sharedLoader.load(siteId,options);
}

export function regionalVariables(product,group){
  return (product?.variables||[]).filter(v=>!group||v.group===group).map(v=>({id:v.id,label:v.label,group:v.group,status:v.status,unit:v.annualUnit||v.unit,source:v.source,resolution:v.resolution,coverage:v.coverage,reason:v.reason}));
}

export function summarizeRegionalEvidence(product,{year,variable='power-precipitation'}={}){
  const item=product?.variables?.find(v=>v.id===variable),selectedYear=Number(year),row=item?.annual?.find(p=>p.year===selectedYear);
  const available=Number.isInteger(selectedYear)&&item?.status==='available'&&finite(row?.value);
  const observed=item?.annual?.filter(p=>finite(p.value))||[],first=observed[0]?.year,last=observed.at(-1)?.year;
  const lastSourceYear=item?.annual?.at(-1)?.year??last;
  const future=Number.isInteger(selectedYear)&&lastSourceYear!=null&&selectedYear>lastSourceYear;
  const reason=!item?'This source variable is not in the prepared inventory.':item.status!=='available'?item.reason||'No numeric source values are available.':future?`The ${item.source?.name||'source'} record ends in ${lastSourceYear}; no value is carried into ${selectedYear}.`:!row?'No source months are available for this year.':!available?`${row.validMonths}/12 valid source months; this annual aggregation is unavailable.`:'';
  const selectedMonthly=(item?.monthly||[]).filter(p=>Number(p.date.slice(0,4))===selectedYear);
  return {available,status:available?'available':item?.status==='not-imported'?'not-imported':future?'beyond-record':'missing',siteId:product?.site?.id,site:product?.site,variable,label:item?.label||variable,group:item?.group,year:selectedYear,value:available?row.value:null,unit:item?.annualUnit||item?.unit||'unit not supplied',monthlyUnit:item?.unit||'unit not supplied',validMonths:row?.validMonths??0,complete:!!row?.complete,firstYear:first??null,lastYear:last??null,annual:item?.annual||[],monthly:selectedMonthly,coverage:item?.coverage||null,source:item?.source||null,provenance:item?.provenance||null,trend:item?.trend||null,resolution:item?.resolution||'Regional resolution not supplied',evidence:item?.evidence,aggregation:item?.aggregation,quality:item?.quality||null,caveats:item?.caveats||[],reason,importCommand:item?.importCommand};
}
