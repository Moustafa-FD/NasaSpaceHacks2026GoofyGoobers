// Fixed-reference place context: never a population forecast or facility count.
export function decodeCities(doc) {
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.cities)) return [];
  return doc.cities.map(([id,name,lat,lon,population,year,scope,region,country,minZoom,source]) =>
    ({id,name,lat,lon,population,year,scope,region,country,minZoom,source}))
    .filter(c => typeof c.name === 'string' && Number.isFinite(c.lat) && Math.abs(c.lat)<=90 && Number.isFinite(c.lon) && Math.abs(c.lon)<=180);
}
export function cityDistance(a,b) {
  const rad=Math.PI/180,dlat=(a.lat-b.lat)*rad,dlon=(a.lon-b.lon)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));
}
export function populationText(city) {
  if (!Number.isFinite(city.population) || city.population<0) return 'Population unavailable';
  const number=Math.round(city.population).toLocaleString('en-US');
  if(city.scope==='metro-estimate')return `Metro est. ${number} · year unavailable`;
  return `${number} people · ${city.year ?? 'year unavailable'} census`;
}
export function citySource(city) {
  return city.source==='natural-earth'
    ? 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/'
    : `https://www.census.gov/quickfacts/fact/table/${encodeURIComponent(city.source)}/POP010220`;
}
export function nearestCity(cities,point,maxDistance=35000) {
  let best=null,distance=maxDistance;
  for(const city of cities){const d=cityDistance(city,point);if(d<distance){best=city;distance=d;}}
  return best?{city:best,distance}:null;
}
export function selectLabelCandidates(cities,point,height,limit=120) {
  const zoom=Math.max(1,Math.log2(40075000/Math.max(100,height*1.5)));
  const radius=Math.min(11000000,Math.max(35000,height*2.5));
  return cities.filter(c=>c.minZoom<=zoom+1 && cityDistance(c,point)<radius)
    .sort((a,b)=>(a.minZoom-b.minZoom)||((b.population||0)-(a.population||0))).slice(0,limit);
}

/** Bounded 48-label pool, projected/collision-checked at most twice per second.
 * Local context remains readable even if a town's real center is outside the view.
 */
export async function createCityLabels(viewer,{fetcher=fetch}={}) {
  const C=globalThis.Cesium,scene=viewer.scene;
  const response=await fetcher('data/cities.json');
  if(!response.ok)throw new Error('Place catalog unavailable');
  const cities=decodeCities(await response.json());
  const collection=scene.primitives.add(new C.LabelCollection({scene}));
  const pool=Array.from({length:48},()=>collection.add({show:false,
    font:'500 12px sans-serif',fillColor:C.Color.fromCssColorString('#f2f6e9'),
    outlineColor:C.Color.fromCssColorString('#152a30'),outlineWidth:3,
    style:C.LabelStyle.FILL_AND_OUTLINE,showBackground:true,
    backgroundColor:C.Color.fromCssColorString('#10232b').withAlpha(.62),
    backgroundPadding:new C.Cartesian2(7,4),pixelOffset:new C.Cartesian2(0,-14),
    verticalOrigin:C.VerticalOrigin.BOTTOM,horizontalOrigin:C.HorizontalOrigin.CENTER,disableDepthTestDistance:Number.POSITIVE_INFINITY}));
  const positions=new Map(cities.map(c=>[c.id,C.Cartesian3.fromDegrees(c.lon,c.lat,20)]));
  const badge=document.createElement('a');badge.id='cityContext';badge.hidden=true;
  badge.target='_blank';badge.rel='noopener';badge.setAttribute('aria-label','Nearby city and population source');
  badge.style.cssText='position:absolute;right:18px;bottom:225px;z-index:6;max-width:280px;padding:9px 13px;border:1px solid #98b3b546;border-radius:9px;background:#13262cdd;color:#e6f2ec;text-decoration:none;white-space:pre-line;font:12px/1.5 sans-serif';
  viewer.container.appendChild(badge);
  const occluder=new C.EllipsoidalOccluder(scene.globe.ellipsoid,viewer.camera.positionWC);
  const centerPixel=new C.Cartesian2(),screenPoint=new C.Cartesian2();
  let last=0,removed=false;
  function update(){
    const now=performance.now();if(now-last<500)return;last=now;
    const width=scene.canvas.clientWidth,heightPx=scene.canvas.clientHeight;
    const canvasRect=scene.canvas.getBoundingClientRect(),timelineRect=document.querySelector('#timeline')?.getBoundingClientRect();
    const reservedBottom=timelineRect&&timelineRect.top<canvasRect.bottom?Math.max(20,canvasRect.bottom-timelineRect.top+18):20;
    badge.style.bottom=`${reservedBottom}px`;
    centerPixel.x=width/2;centerPixel.y=heightPx/2;
    const ray=viewer.camera.getPickRay(centerPixel);
    const focus=ray&&scene.globe.pick(ray,scene);
    const cart=focus?C.Cartographic.fromCartesian(focus):viewer.camera.positionCartographic;
    const point={lat:C.Math.toDegrees(cart.latitude),lon:C.Math.toDegrees(cart.longitude)};
    const height=viewer.camera.positionCartographic.height;
    const nearby=height<30000?nearestCity(cities,point):null;
    badge.hidden=!nearby;
    if(nearby){const {city,distance}=nearby;badge.textContent=`Near ${city.name}${distance>3000?` · ${(distance/1000).toFixed(1)} km to center`:''}\n${populationText(city)}`;
      badge.href=citySource(city);badge.title=`${city.name}, ${city.region}, ${city.country}. ${city.scope==='metro-estimate'?'Natural Earth metro estimate, reference year unspecified.':'US Census city/CDP count at April 1, 2020.'} Fixed reference; does not change with the simulation timeline. Click for source.`;
      Object.assign(badge.dataset,{city:city.name,population:city.population??'',referenceYear:city.year??'unknown',scope:city.scope});}
    occluder.cameraPosition=viewer.camera.positionWC;
    const boxes=[];let used=0;
    for(const city of selectLabelCandidates(cities,point,height)){
      const position=positions.get(city.id);if(!occluder.isPointVisible(position))continue;
      const projected=C.SceneTransforms.worldToWindowCoordinates(scene,position,screenPoint);
      if(!projected||projected.x<90||projected.x>width-90||projected.y<80||projected.y>heightPx-reservedBottom)continue;
      // Name only on the globe (less clutter); population stays in the pick id and the nearby badge.
      const w=Math.min(220,city.name.length*7.5)+16;
      const box={x:projected.x-w/2,y:projected.y-28,w,h:28};
      if(boxes.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y))continue;
      boxes.push(box);const label=pool[used++];label.position=position;label.text=city.name;label.show=true;
      label.id={city:city.name,population:city.population,referenceYear:city.year,source:citySource(city)};
      if(used===pool.length)break;
    }
    for(let i=used;i<pool.length;i++)pool[i].show=false;
    badge.dataset.visibleLabels=String(used);
  }
  const remove=scene.postRender.addEventListener(update);
  return {destroy(){if(removed)return;removed=true;remove();scene.primitives.remove(collection);badge.remove();positions.clear();}};
}
