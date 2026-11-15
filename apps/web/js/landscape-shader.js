// GPU timeline treatment for the already-generated neighborhood model.
// Required per-vertex glTF attributes on every primitive: _VEGETATION (0 other,
// 1 tree, 2 crop, 3 ground, 4 water) and _WATER_DISTANCE (signed meters from a
// mapped water boundary; use a large positive value when unavailable).
// PositionMC is the post-instancing local glTF position: [east, height, -north].
// Terrain scenarios and vegetation detail are illustrative, not predictions.

function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const GRASS_PERIOD=8192,EARTH=6378137;
const finite=(value)=>typeof value==='number'&&Number.isFinite(value);
/** Same local equirectangular frame used to project cached OSM source geometry. */
export function evidenceCoordinateFrame(center={}){
  const lat=finite(center.lat)?Math.max(-85,Math.min(85,center.lat)):0,lon=finite(center.lon)?center.lon:0;
  return [lon,lat,180/(Math.PI*EARTH*Math.cos(lat*Math.PI/180)),180/(Math.PI*EARTH)];
}
/** Textures follow WebGL's bottom-to-top convention: first row is SOUTH. */
export function normalizeEvidenceTexture(value){
  if(value?.active!==true)return null;
  const {rgba,width,height,bounds}=value;
  if(!(rgba instanceof Uint8Array)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>2048||height>2048||rgba.length!==width*height*4||!Array.isArray(bounds)||bounds.length!==4||!bounds.every(finite))return null;
  const [west,south,east,north]=bounds,span=east>west?east-west:east-west+360;
  if(west< -180||west>180||east< -180||east>180||east===west||south< -90||north>90||north<=south||span<=0||span>360)return null;
  let key=typeof value.key==='string'?value.key:null;
  if(!key){let n=2166136261;for(const byte of rgba)n=Math.imul(n^byte,16777619);key=width+'x'+height+':'+bounds.join(',')+':'+(n>>>0);}
  return {active:true,rgba:rgba.slice(),width,height,bounds:[...bounds],key};
}
/** Bounded wall-clock display blend. Supplied source values are never changed.
 * The renderer samples both real rasters only where the incoming year is valid. */
export function createEvidenceTransition({durationMs=700,now=()=>performance.now(),onChange=()=>{}}={}){
  let current=null,previous=null,mix=1,started=0;
  const changed=(textures)=>onChange({current,previous,mix,textures});
  return {
    set(image){
      if(!image){if(!current&&!previous)return false;current=previous=null;mix=1;changed('all');return true;}
      if(current?.key===image.key)return false;
      previous=current;current=image;mix=0;started=now();changed('all');return true;
    },
    tick(){
      if(!current||mix>=1)return false;
      const t=Math.max(0,Math.min(1,(now()-started)/Math.max(1,durationMs)));mix=t*t*(3-2*t);
      if(t>=1){previous=null;changed('previous');return false;}
      changed(false);return true;
    },
    get state(){return {current,previous,mix};},
  };
}
/** CPU reference: absent incoming pixels remain absent, rather than borrowing an
 * earlier date's data. Colors here are linear and the result is display-only. */
export function blendEvidencePixels(previous,current,mix){
  const t=Math.max(0,Math.min(1,mix));
  if(!current||current[3]<=0)return [0,0,0,0];
  if(!previous||previous[3]<=0)return [...current.slice(0,3),current[3]*t];
  return current.map((value,i)=>previous[i]*(1-t)+value*t);
}
export function evidenceTextureCoordinate(center,east,north,bounds){
  const frame=evidenceCoordinateFrame(center),lon=frame[0]+east*frame[2],lat=frame[1]+north*frame[3];
  const span=bounds[2]>bounds[0]?bounds[2]-bounds[0]:bounds[2]-bounds[0]+360,dx=((lon-bounds[0])%360+360)%360;
  const u=dx/span,v=(lat-bounds[1])/(bounds[3]-bounds[1]);
  return u>=0&&u<=1&&v>=0&&v<=1?[u,v]:null;
}
function evidenceUniform(Cesium,evidence){
  return new Cesium.TextureUniform({typedArray:evidence?.rgba||new Uint8Array(4),width:evidence?.width||1,height:evidence?.height||1,
    pixelFormat:Cesium.PixelFormat.RGBA,pixelDatatype:Cesium.PixelDatatype.UNSIGNED_BYTE,
    minificationFilter:Cesium.TextureMinificationFilter.NEAREST,magnificationFilter:Cesium.TextureMagnificationFilter.NEAREST,repeat:false});
}
/** Cesium's TextureManager destroys the previous GPU texture on replacement;
 * existing CustomShader.destroy calls release both DEM and evidence textures. */
export function setLandscapeEvidence(Cesium,shader,evidence,previous=null,mix=1){
  if(shader.isDestroyed?.())return;
  shader.setUniform('u_evidenceActive',evidence?1:0);
  shader.setUniform('u_evidenceBounds',new Cesium.Cartesian4(...(evidence?.bounds||[-180,-90,180,90])));
  shader.setUniform('u_evidence',evidenceUniform(Cesium,evidence));
  shader.setUniform('u_evidencePreviousActive',previous?1:0);
  shader.setUniform('u_evidencePreviousBounds',new Cesium.Cartesian4(...(previous?.bounds||[-180,-90,180,90])));
  shader.setUniform('u_evidencePrevious',evidenceUniform(Cesium,previous));
  shader.setUniform('u_evidenceMix',mix);
}
export function clearLandscapeEvidencePrevious(Cesium,shader){
  if(shader.isDestroyed?.())return;
  shader.setUniform('u_evidencePreviousActive',0);shader.setUniform('u_evidencePrevious',evidenceUniform(Cesium,null));
}
const wrapGrass=(value)=>((value%GRASS_PERIOD)+GRASS_PERIOD)%GRASS_PERIOD;
/** Source snapshots use local equirectangular metres. Recover a shared global
 * coordinate phase in double precision, then upload only its small periodic
 * remainder: adjacent patches agree without metre-sized Float32 precision loss.
 */
export function grassCoordinateFrame(center={}){
  const lat=(Number.isFinite(center.lat)?Math.max(-85,Math.min(85,center.lat)):0)*Math.PI/180;
  const lon=(Number.isFinite(center.lon)?center.lon:0)*Math.PI/180;
  return {origin:[wrapGrass(EARTH*lon),wrapGrass(EARTH*lat)],scale:[1/Math.cos(lat),1],period:GRASS_PERIOD};
}
export function grassWorldCoordinate(frame,east,north){return [wrapGrass(frame.origin[0]+east*frame.scale[0]),wrapGrass(frame.origin[1]+north*frame.scale[1])];}
export function grassMaterialDomain(kind,rgb,flooded=false){return !flooded&&kind>2.5&&kind<3.5&&rgb[1]>rgb[0]*.94&&rgb[1]>rgb[2]*1.10;}
export function grassDetailWeight(footprint){const t=Math.max(0,Math.min(1,(Math.max(0,footprint)*6.5-.24)/.56));return 1-t*t*(3-2*t);}
export function groundMaterialDomain(kind,flooded=false){return !flooded&&kind>2.5&&kind<3.5;}
const smooth=(low,high,value)=>{const t=Math.max(0,Math.min(1,(value-low)/(high-low)));return t*t*(3-2*t);};
/** CPU reference for the fragment shader's continuous appearance weights.
 * Input is LINEAR terrain color, not a measured soil/vegetation classification.
 * Output order is green grass, dry turf/soil, neutral rock, pale warm sand.
 */
export function groundMaterialWeights(rgb){
  const [r,g,b]=rgb,top=Math.max(r,g,b,.001);
  const grass=smooth(-.02,.18,(g-r)/top)*smooth(.08,.35,(g-b)/top);
  const warm=smooth(.05,.35,(r-b)/top),pale=smooth(.28,.58,top),rest=1-grass;
  return [grass,rest*warm*(1-pale),rest*(1-warm),rest*warm*pale];
}
// Local display metres: centimetre blades, sub-metre grains, metre-sized turf
// variation and broader colour patches. No building-sized grass/stone shapes.
export const GROUND_MATERIAL_SCALES=Object.freeze({bladeLengthM:.08,grainM:.125,tuftM:.5,patchM:8,broadM:32});

/** RG = unsigned 16-bit elevation, B = valid-sample mask, A = opaque.
 * Rows remain south→north. Shader performs manual bilinear interpolation after
 * decoding four NEAREST samples, avoiding byte-boundary interpolation errors.
 */
export function packElevationTexture(elevation) {
  const usable = elevation && Number.isInteger(elevation.width) && elevation.width >= 2 && Number.isInteger(elevation.height) && elevation.height >= 2 && elevation.heights?.length === elevation.width * elevation.height;
  const width = usable ? elevation.width : 2, height = usable ? elevation.height : 2;
  const heights = usable ? elevation.heights : [null, null, null, null];
  const valid = [...heights].filter((v) => typeof v === 'number' && Number.isFinite(v));
  const min = valid.length ? Math.min(...valid) : 0;
  const span = valid.length ? Math.max(1, Math.max(...valid) - min) : 1;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < heights.length; i++) {
    const value = heights[i], known = typeof value === 'number' && Number.isFinite(value);
    const encoded = known ? Math.round(Math.max(0, Math.min(1, (value - min) / span)) * 65535) : 0;
    data[i * 4] = encoded >> 8;
    data[i * 4 + 1] = encoded & 255;
    data[i * 4 + 2] = known ? 255 : 0;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height, min, span, maxQuantizationErrorM: span / 65535 };
}

export const LANDSCAPE_VERTEX_SHADER = `
float lpDecode(vec4 texel) {
    return u_demRange.x + (texel.r * 65280.0 + texel.g * 255.0) / 65535.0 * u_demRange.y;
}
vec2 lpElevation(vec2 local) {
    vec2 uv = (local - u_extent.xy) / (u_extent.zw - u_extent.xy);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0);
    vec2 coord = uv * (u_demSize - 1.0);
    vec2 cell = min(floor(coord), u_demSize - 2.0);
    vec2 t = coord - cell;
    vec4 a = texture(u_dem, (cell + vec2(0.5, 0.5)) / u_demSize);
    vec4 b = texture(u_dem, (cell + vec2(1.5, 0.5)) / u_demSize);
    vec4 c = texture(u_dem, (cell + vec2(0.5, 1.5)) / u_demSize);
    vec4 d = texture(u_dem, (cell + vec2(1.5, 1.5)) / u_demSize);
    vec4 weights = vec4((1.0-t.x)*(1.0-t.y), t.x*(1.0-t.y), (1.0-t.x)*t.y, t.x*t.y);
    if ((weights.x > 0.000001 && a.b < 0.5) || (weights.y > 0.000001 && b.b < 0.5) ||
        (weights.z > 0.000001 && c.b < 0.5) || (weights.w > 0.000001 && d.b < 0.5)) return vec2(0.0);
    return vec2(dot(vec4(lpDecode(a), lpDecode(b), lpDecode(c), lpDecode(d)), weights), 1.0);
}
float lpProgress() {
    return smoothstep(2025.0, 2035.0, u_year) * clamp(u_scenario, 0.0, 1.0);
}
float lpDeformation(vec2 local, float progress) {
    vec2 center = vec2(-1150.0 + 250.0*progress, 1000.0 + 180.0*progress);
    float sigma = 850.0 + 180.0*progress;
    vec2 delta = local - center;
    float mountain = 180.0*progress * exp(-dot(delta,delta)/(2.0*sigma*sigma));
    float riverX = 450.0 + 120.0*progress*sin(local.y/850.0);
    float riverDistance = (local.x-riverX)/220.0;
    float alongRiver = local.y/2200.0;
    float valley = 12.0*progress * exp(-riverDistance*riverDistance/2.0) * exp(-alongRiver*alongRiver/2.0);
    vec2 fromWestSouth = (local-u_extent.xy)/(u_extent.zw-u_extent.xy);
    vec2 fromEastNorth = (u_extent.zw-local)/(u_extent.zw-u_extent.xy);
    float edge = min(min(fromWestSouth.x,fromWestSouth.y),min(fromEastNorth.x,fromEastNorth.y));
    return (mountain-valley)*smoothstep(0.0,0.12,edge);
}
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
    vec3 p = vsInput.attributes.positionMC;
    vec2 local = vec2(p.x,-p.z);
    float kind = vsInput.attributes.vegetation;
    float patchiness = (sin(local.x/430.0+u_sitePhase)*cos(local.y/510.0-u_sitePhase)+1.0)/2.0;
    float progress = lpProgress();
    float health = clamp(u_health,0.0,1.0);
    health = clamp(health-(1.0-health)*0.24*patchiness-0.35*progress*patchiness,0.0,1.0);
    v_lpKind = kind;
    v_lpHealth = health;
    v_lpLocal = local;
    v_lpWaterDistance = vsInput.attributes.water_distance;
    if (kind > 0.5 && kind < 2.5) {
        vec2 dem = lpElevation(local);
        if (dem.y > 0.5) {
            float base = dem.x+4.0-dot(local,local)/(2.0*6371000.0);
            float growth = kind < 1.5 ? mix(0.55,1.0,health) : mix(0.18,1.0,health);
            vsOutput.positionMC.y = base+(p.y-base)*growth;
        }
    }
    if (progress > 0.0001) vsOutput.positionMC.y += lpDeformation(local,progress);
    if (kind > 3.5 && kind < 4.5) vsOutput.positionMC.y += 8.0*progress;
}
`;

export const LANDSCAPE_FRAGMENT_SHADER = `
vec2 lpEvidenceUV(vec2 geo,vec4 bounds) {
    float span=bounds.z-bounds.x;if(span<=0.0)span+=360.0;
    return vec2(mod(geo.x-bounds.x+360.0,360.0)/span,(geo.y-bounds.y)/(bounds.w-bounds.y));
}
bool lpEvidenceInside(vec2 uv) {
    return all(greaterThanEqual(uv,vec2(0.0))) && all(lessThanEqual(uv,vec2(1.0)));
}
float lpGrassHash(vec2 p) {
    vec3 q=fract(vec3(p.x,p.y,p.x)*0.1031);
    q+=dot(q,q.yzx+33.33);
    return fract((q.x+q.y)*q.z);
}
float lpGrassNoise(vec2 p,float period) {
    vec2 i=floor(p),f=fract(p);
    f=f*f*(3.0-2.0*f);
    float a=lpGrassHash(mod(i,period));
    float b=lpGrassHash(mod(i+vec2(1.0,0.0),period));
    float c=lpGrassHash(mod(i+vec2(0.0,1.0),period));
    float d=lpGrassHash(mod(i+vec2(1.0),period));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
vec4 lpGroundWeights(vec3 color) {
    float top=max(max(color.r,color.g),max(color.b,0.001));
    float grass=smoothstep(-0.02,0.18,(color.g-color.r)/top)
               *smoothstep(0.08,0.35,(color.g-color.b)/top);
    float warm=smoothstep(0.05,0.35,(color.r-color.b)/top);
    float pale=smoothstep(0.28,0.58,top),rest=1.0-grass;
    return vec4(grass,rest*warm*(1.0-pale),rest*(1.0-warm),rest*warm*pale);
}
vec2 lpGroundMaterial(vec2 local,vec4 weights) {
    vec2 world=mod(u_grassOrigin+local*u_grassScale,8192.0);
    // Geographic periodic phase agrees across streamed patches. Measure pixel
    // footprint before wrapping so a period boundary cannot create an AA seam.
    vec2 projected=fwidth(local*u_grassScale);
    float metresPerPixel=max(projected.x,projected.y);
    // Blended, differently oriented scales retain softly irregular material
    // patches without tiling squares or parallel colour stripes.
    float broad=0.65*lpGrassNoise(world/32.0,256.0)
               +0.35*lpGrassNoise(vec2(world.x+world.y,world.y-world.x)/8.0,1024.0);
    float surfaceFade=1.0-smoothstep(0.125,0.90,metresPerPixel);
    float surface=0.5,grain=0.0;
    if(surfaceFade>0.001) {
        surface=mix(0.5,smoothstep(0.18,0.82,lpGrassNoise(world*2.0,16384.0)),surfaceFade);
        float grainFade=1.0-smoothstep(0.025,0.11,metresPerPixel);
        if(grainFade>0.001) grain=(lpGrassNoise(world*8.0,65536.0)-0.5)*grainFade;
    }
    vec2 q=world*vec2(5.5,6.5);
    vec2 pixel=projected*vec2(5.5,6.5);
    float footprint=max(pixel.x,pixel.y);
    float fineFade=1.0-smoothstep(0.24,0.80,footprint);
    float blade=0.0,bladeTone=0.0;
    if(fineFade>0.001 && weights.x+weights.y>0.01) {
        vec2 cell=mod(floor(q),vec2(45056.0,53248.0));
        float seed=lpGrassHash(cell);
        float other=lpGrassHash(cell+vec2(19.0,71.0));
        vec2 center=vec2(0.35)+0.30*vec2(seed,other);
        float angle=6.28318530718*lpGrassHash(cell+vec2(47.0,13.0));
        vec2 axis=vec2(cos(angle),sin(angle)),delta=fract(q)-center;
        vec2 bladeSpace=vec2(dot(delta,axis),dot(delta,vec2(-axis.y,axis.x)));
        float aa=max(0.005,footprint*0.55);
        blade=(1.0-smoothstep(0.13-aa,0.22+aa,abs(bladeSpace.x)))
             *(1.0-smoothstep(0.012-aa,0.032+aa,abs(bladeSpace.y)));
        bladeTone=blade*fineFade*(other*0.30-0.15);
    }
    // Each base colour keeps its hue; only physical surface character changes.
    // Dry ground has sparse straw/grains, rock has chipped aggregate contrast,
    // sand has softer fine grains. These are artistic material cues, not geology.
    vec4 textureTone=vec4((surface-0.5)*0.16+bladeTone,
                         (surface-0.5)*0.30+bladeTone*0.45+grain*0.16,
                         (abs(surface-0.5)*2.0-0.5*surfaceFade)*0.30+grain*0.22,
                         (surface-0.5)*0.12+grain*0.18);
    float roughness=dot(weights,vec4(0.96,0.98,0.88,0.99))+(0.5-broad)*0.04;
    // Softer lawn contrast avoids camouflage-sized islands beside small homes;
    // dry soil and rock retain their stronger aggregate/color variation.
    float broadContrast=mix(0.36,0.20,weights.x);
    return vec2(1.0+broadContrast*(broad-0.5)+dot(weights,textureTone),clamp(roughness,0.82,1.0));
}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    float viewDistance = length(v_lpLocal-u_viewCircle.xy);
    float viewFade = 1.0-smoothstep(max(0.0,u_viewCircle.z-600.0),u_viewCircle.z,viewDistance);
    float patchFade = 1.0-smoothstep(max(0.0,u_patchRadius-600.0),u_patchRadius,length(v_lpLocal));
    float coverage = viewFade*patchFade*clamp(u_patchOpacity,0.0,1.0);
    // Ordered screen dither keeps the main material opaque and depth-correct.
    // Opposite retiring thresholds complement the arriving patch's coverage.
    const mat4 bayer = mat4(0.0,8.0,2.0,10.0,12.0,4.0,14.0,6.0,3.0,11.0,1.0,9.0,15.0,7.0,13.0,5.0);
    ivec2 pixel = ivec2(mod(floor(gl_FragCoord.xy),4.0));
    float threshold = (bayer[pixel.x][pixel.y]+0.5)/16.0;
    threshold = mix(threshold,1.0-threshold,u_patchRetiring);
    if (coverage <= threshold) discard;
    float kind = v_lpKind;
    float health = v_lpHealth;
    float progress = smoothstep(2025.0,2035.0,u_year)*clamp(u_scenario,0.0,1.0);
    vec3 original = material.diffuse;
    bool green = original.g > original.r*0.94 && original.g > original.b*1.10;
    float shoreAdvance = progress*(110.0+42.0*sin(v_lpLocal.y/850.0));
    bool floodedGround = kind > 2.5 && kind < 3.5 && progress > 0.0001 && v_lpWaterDistance < shoreAdvance;
    if (kind > 0.5 && kind < 1.5 && green) {
        material.diffuse = mix(pow(vec3(0.40,0.24,0.10),vec3(2.2)),original,health);
        if (health < 0.13) discard; // Stylized bare canopy; brown trunk remains.
    } else if (kind > 1.5 && kind < 2.5) {
        vec3 crop = mix(vec3(0.66,0.46,0.15),vec3(0.26,0.43,0.13),smoothstep(0.25,0.85,health));
        material.diffuse = pow(mix(vec3(0.36,0.24,0.11),crop,smoothstep(0.05,0.35,health)),vec3(2.2));
    } else if (kind > 2.5 && kind < 3.5) {
        // Classify the original blended land tint, before illustrative NDVI
        // stress, so scrubbing years cannot turn an area into a different soil.
        vec4 groundWeights=lpGroundWeights(original);
        vec3 stressed=mix(pow(vec3(0.42,0.34,0.20),vec3(2.2)),original,0.55+0.45*health);
        material.diffuse=mix(original,stressed,groundWeights.x);
        if(!floodedGround) {
            vec2 ground=lpGroundMaterial(v_lpLocal,groundWeights);
            material.diffuse*=ground.x;
            material.roughness=ground.y;
            material.specular=min(material.specular,vec3(0.025));
        }
    }
    if ((kind > 3.5 && kind < 4.5) || floodedGround) {
        float ripple = 0.015*sin(v_lpLocal.x*0.032+v_lpLocal.y*0.021+u_year*0.7);
        vec3 water = pow(vec3(0.19,0.39,0.48)+ripple,vec3(2.2));
        material.diffuse = floodedGround ? water : mix(original,water,0.25);
        material.roughness = 0.30;
        material.specular = vec3(0.04);
    }
    // Only real raster coverage tints ground/water. Buildings, roads, planting
    // and air stay unchanged; no point measurement is expanded into a field.
    if (u_evidenceActive > 0.5 && kind > 2.5 && kind < 4.5) {
        vec2 geo=u_patchGeo.xy+v_lpLocal*u_patchGeo.zw;
        vec2 uv=lpEvidenceUV(geo,u_evidenceBounds);
        if(lpEvidenceInside(uv)) {
            vec4 evidence=texture(u_evidence,uv);
            if(evidence.a>0.0) {
                vec3 evidenceColor=pow(evidence.rgb,vec3(2.2));
                float evidenceAlpha=evidence.a*u_evidenceMix;
                vec2 oldUV=lpEvidenceUV(geo,u_evidencePreviousBounds);
                if(u_evidencePreviousActive>0.5 && u_evidenceMix<1.0 && lpEvidenceInside(oldUV)) {
                    vec4 previous=texture(u_evidencePrevious,oldUV);
                    if(previous.a>0.0) {
                        evidenceColor=mix(pow(previous.rgb,vec3(2.2)),evidenceColor,u_evidenceMix);
                        evidenceAlpha=mix(previous.a,evidence.a,u_evidenceMix);
                    }
                }
                material.diffuse=mix(material.diffuse,evidenceColor,evidenceAlpha);
            }
        }
    }
}
`;

/** Create once per model; update u_health/u_year/u_scenario on timeline events.
 * u_health is normalized display health, not raw NDVI. Scenario stress is added
 * here, so callers should not apply scenario stress to u_health a second time.
 * Destroy the CustomShader when its model leaves the scene to release texture.
 * Shoreline advance is an artistic color treatment, not a flood-volume solver.
 */
export function createLandscapeShader(Cesium, elevation = null, options = {}) {
  const texture = packElevationTexture(elevation);
  const extent = elevation?.extentM || [-3300,-3300,3300,3300];
  const grassFrame=grassCoordinateFrame(options.center||elevation?.center);
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_health: { type: Cesium.UniformType.FLOAT, value: 1 },
      u_year: { type: Cesium.UniformType.FLOAT, value: 2025 },
      u_scenario: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_evidenceActive: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_evidenceBounds: { type: Cesium.UniformType.VEC4, value: new Cesium.Cartesian4(-180,-90,180,90) },
      u_patchGeo: { type: Cesium.UniformType.VEC4, value: new Cesium.Cartesian4(...evidenceCoordinateFrame(options.center||elevation?.center)) },
      u_evidence: { type: Cesium.UniformType.SAMPLER_2D, value: evidenceUniform(Cesium,null) },
      u_evidencePreviousActive: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_evidencePreviousBounds: { type: Cesium.UniformType.VEC4, value: new Cesium.Cartesian4(-180,-90,180,90) },
      u_evidencePrevious: { type: Cesium.UniformType.SAMPLER_2D, value: evidenceUniform(Cesium,null) },
      u_evidenceMix: { type: Cesium.UniformType.FLOAT, value: 1 },
      u_viewCircle: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0,0,1000000) },
      u_patchRadius: { type: Cesium.UniformType.FLOAT, value: 1000000 },
      u_patchOpacity: { type: Cesium.UniformType.FLOAT, value: 1 },
      u_patchRetiring: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_grassOrigin: { type: Cesium.UniformType.VEC2, value: new Cesium.Cartesian2(...grassFrame.origin) },
      u_grassScale: { type: Cesium.UniformType.VEC2, value: new Cesium.Cartesian2(...grassFrame.scale) },
      u_sitePhase: { type: Cesium.UniformType.FLOAT, value: hash(elevation?.siteId || 'landscape') / 4294967296 * Math.PI * 2 },
      u_demRange: { type: Cesium.UniformType.VEC2, value: new Cesium.Cartesian2(texture.min, texture.span) },
      u_demSize: { type: Cesium.UniformType.VEC2, value: new Cesium.Cartesian2(texture.width, texture.height) },
      u_extent: { type: Cesium.UniformType.VEC4, value: new Cesium.Cartesian4(...extent) },
      u_dem: { type: Cesium.UniformType.SAMPLER_2D, value: new Cesium.TextureUniform({
        typedArray: texture.data, width: texture.width, height: texture.height,
        pixelFormat: Cesium.PixelFormat.RGBA, pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST, repeat: false,
      }) },
    },
    varyings: {
      v_lpKind: Cesium.VaryingType.FLOAT,
      v_lpHealth: Cesium.VaryingType.FLOAT,
      v_lpLocal: Cesium.VaryingType.VEC2,
      v_lpWaterDistance: Cesium.VaryingType.FLOAT,
    },
    vertexShaderText: LANDSCAPE_VERTEX_SHADER,
    fragmentShaderText: LANDSCAPE_FRAGMENT_SHADER,
  });
}
