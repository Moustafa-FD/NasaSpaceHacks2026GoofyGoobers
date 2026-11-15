// Bounded, cached USGS discovery for the web picker. Monitoring-location metadata
// does not promise any particular water-quality parameter or date coverage.
const cache=new Map();
async function nearbyWaterStations(params,{fetchImpl=fetch,now=Date.now}={}){
  const lat=Number(params.get('lat')),lon=Number(params.get('lon'));
  if(!params.has('lat')||!params.has('lon')||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180)throw new Error('Valid lat/lon required');
  const key=lat.toFixed(2)+','+lon.toFixed(2),known=cache.get(key);
  if(known&&now()-known.time<600000)return known.value;
  const dx=.2/Math.cos(lat*Math.PI/180),bbox=[Math.max(-180,lon-dx),lat-.2,Math.min(180,lon+dx),lat+.2].join(',');
  const url='https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items?'+new URLSearchParams({bbox,agency_code:'USGS',site_type_code:'ST',limit:'500',f:'json'});
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/geo+json'}});
  if(!response.ok)throw new Error('USGS station discovery unavailable (HTTP '+response.status+')');
  const body=await response.json();
  const stations=(body.features||[]).map(f=>{const p=f.properties||{},c=f.geometry?.coordinates;return {id:p.monitoring_location_id||f.id,name:p.monitoring_location_name||p.station_nm||f.id,lon:c?.[0],lat:c?.[1]};})
    .filter(s=>/^USGS-\d{8,15}$/.test(s.id)&&Number.isFinite(s.lat)&&Number.isFinite(s.lon))
    .map(s=>({...s,distanceKm:Math.hypot((s.lat-lat)*111.32,(s.lon-lon)*111.32*Math.cos(lat*Math.PI/180))}))
    .sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,20);
  const value={stations,sourceUrl:url,warnings:['Stream monitoring locations may lack the selected water-quality parameters or dates. Distances are straight-line, not downstream connectivity. Search is bounded to the first 500 USGS stream locations.']};
  cache.set(key,{time:now(),value});while(cache.size>20)cache.delete(cache.keys().next().value);
  return value;
}
module.exports={nearbyWaterStations};
