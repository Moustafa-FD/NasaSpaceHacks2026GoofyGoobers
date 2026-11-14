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
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    float kind = v_lpKind;
    float health = v_lpHealth;
    float progress = smoothstep(2025.0,2035.0,u_year)*clamp(u_scenario,0.0,1.0);
    vec3 original = material.diffuse;
    bool green = original.g > original.r*0.94 && original.g > original.b*1.10;
    if (kind > 0.5 && kind < 1.5 && green) {
        material.diffuse = mix(pow(vec3(0.40,0.24,0.10),vec3(2.2)),original,health);
        if (health < 0.13) discard; // Stylized bare canopy; brown trunk remains.
    } else if (kind > 1.5 && kind < 2.5) {
        vec3 crop = mix(vec3(0.66,0.46,0.15),vec3(0.26,0.43,0.13),smoothstep(0.25,0.85,health));
        material.diffuse = pow(mix(vec3(0.36,0.24,0.11),crop,smoothstep(0.05,0.35,health)),vec3(2.2));
    } else if (kind > 2.5 && kind < 3.5 && green) {
        material.diffuse = mix(pow(vec3(0.42,0.34,0.20),vec3(2.2)),original,0.55+0.45*health);
    }
    float shoreAdvance = progress*(110.0+42.0*sin(v_lpLocal.y/850.0));
    bool floodedGround = kind > 2.5 && kind < 3.5 && progress > 0.0001 && v_lpWaterDistance < shoreAdvance;
    if ((kind > 3.5 && kind < 4.5) || floodedGround) {
        float ripple = 0.015*sin(v_lpLocal.x*0.032+v_lpLocal.y*0.021+u_year*0.7);
        vec3 water = pow(vec3(0.19,0.39,0.48)+ripple,vec3(2.2));
        material.diffuse = floodedGround ? water : mix(original,water,0.25);
        material.roughness = 0.30;
        material.specular = vec3(0.04);
    }
}
`;

/** Create once per model; update u_health/u_year/u_scenario on timeline events.
 * u_health is normalized display health, not raw NDVI. Scenario stress is added
 * here, so callers should not apply scenario stress to u_health a second time.
 * Destroy the CustomShader when its model leaves the scene to release texture.
 * Shoreline advance is an artistic color treatment, not a flood-volume solver.
 */
export function createLandscapeShader(Cesium, elevation = null) {
  const texture = packElevationTexture(elevation);
  const extent = elevation?.extentM || [-3300,-3300,3300,3300];
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_health: { type: Cesium.UniformType.FLOAT, value: 1 },
      u_year: { type: Cesium.UniformType.FLOAT, value: 2025 },
      u_scenario: { type: Cesium.UniformType.FLOAT, value: 0 },
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
