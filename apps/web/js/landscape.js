// Pure landscape sampling used by the browser and generation worker.
// Baseline = static Copernicus DEM / OSM reference geometry. Changing the year
// does not invent historical terrain. Optional deformation is illustrative.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (lo, hi, v) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
const mix = (a, b, t) => a + (b - a) * t;

/** Bilinear absolute DEM elevation (meters), or null outside/missing coverage.
 * Grid rows progress south→north, columns west→east, flattened row-major.
 * Null samples are never treated as zero; zero-weight missing corners do not
 * invalidate an exact known grid point.
 */
export function sampleElevation(grid, x, y) {
  if (!grid || !numeric(x) || !numeric(y)) return null;
  const { width, height, extentM, heights } = grid;
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2 || !Array.isArray(extentM) || extentM.length !== 4 || !heights || heights.length !== width * height) return null;
  const [west, south, east, north] = extentM;
  if (!(east > west && north > south) || x < west || x > east || y < south || y > north) return null;
  const col = (x - west) / (east - west) * (width - 1);
  const row = (y - south) / (north - south) * (height - 1);
  const i = Math.min(width - 2, Math.floor(col));
  const j = Math.min(height - 2, Math.floor(row));
  const a = col - i, b = row - j;
  const corners = [[j * width + i, (1 - a) * (1 - b)], [j * width + i + 1, a * (1 - b)], [(j + 1) * width + i, (1 - a) * b], [(j + 1) * width + i + 1, a * b]];
  let elevation = 0;
  for (const [index, weight] of corners) {
    if (weight <= 1e-12) continue;
    if (!numeric(heights[index])) return null;
    elevation += heights[index] * weight;
  }
  return elevation;
}

/** Explicit artistic scenario controls, not geological or hydrologic forecasts.
 * Deformation starts at the 2025 baseline and eases toward 2035. Callers must
 * expose a separate, default-off scenario toggle and label it illustrative.
 */
export function scenarioParameters(year = 2025) {
  const selectedYear = numeric(year) ? year : 2025;
  const progress = smoothstep(2025, 2035, selectedYear);
  return {
    baselineYear: 2025,
    year: selectedYear,
    progress,
    mountainHeightM: 180 * progress,
    mountainCenterX: -1150 + 250 * progress,
    mountainCenterY: 1000 + 180 * progress,
    mountainWidthM: 850 + 180 * progress,
    riverBendM: 120 * progress,
    riverErosionM: 12 * progress,
    riverLevelOffsetM: 8 * progress,
    lakeLevelOffsetM: 12 * progress,
    vegetationStress: 0.35 * progress,
    illustrative: true,
  };
}

/** Optional signed illustrative height delta in meters. Zero on extent edges. */
export function scenarioHeightOffset(x, y, year = 2025, extent = [-3300, -3300, 3300, 3300]) {
  if (!numeric(x) || !numeric(y)) return 0;
  const p = scenarioParameters(year);
  if (!p.progress) return 0;
  const [west, south, east, north] = extent;
  const edge = Math.min((x - west) / (east - west), (east - x) / (east - west), (y - south) / (north - south), (north - y) / (north - south));
  const taper = smoothstep(0, 0.12, edge);
  const mountain = p.mountainHeightM * Math.exp(-((x - p.mountainCenterX) ** 2 + (y - p.mountainCenterY) ** 2) / (2 * p.mountainWidthM ** 2));
  const riverX = 450 + p.riverBendM * Math.sin(y / 850);
  const valley = p.riverErosionM * Math.exp(-(((x - riverX) / 220) ** 2) / 2) * Math.exp(-((y / 2200) ** 2) / 2);
  return (mountain - valley) * taper;
}

function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function contains(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const AREA_PRIORITY = { water: 20, forest: 12, orchard: 11, farmland: 10, residential: 8, commercial: 8, industrial: 8, park: 6, grass: 5, scrub: 4 };

/** Construct CPU-only helpers once per neighborhood. No fetches or DOM effects.
 * heightAt returns absolute static DEM elevation (meters) plus an optional
 * explicitly illustrative scenario, never a fabricated missing baseline.
 * healthAt accepts a normalized health display input (0..1), NOT raw NDVI.
 * Its spatial variation is illustrative; no year-based ecological decline is
 * inferred by this helper. Caller-supplied timeline data drives the changes.
 */
export function createLandscape(snapshot, elevation = null) {
  const cells = new Map(), cellSize = 256;
  for (const area of snapshot?.areas || []) {
    if (!Array.isArray(area.polygon) || area.polygon.length < 3) continue;
    const xs = area.polygon.map((p) => p[0]), ys = area.polygon.map((p) => p[1]);
    for (let x = Math.floor(Math.min(...xs) / cellSize); x <= Math.floor(Math.max(...xs) / cellSize); x++) {
      for (let y = Math.floor(Math.min(...ys) / cellSize); y <= Math.floor(Math.max(...ys) / cellSize); y++) {
        const key = `${x},${y}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(area);
      }
    }
  }
  const extent = elevation?.extentM || snapshot?.extentM || [-3300, -3300, 3300, 3300];
  const sitePhase = hash(snapshot?.siteId || 'landscape') / 4294967296 * Math.PI * 2;
  function groundKindAt(x, y) {
    let best;
    for (const area of cells.get(`${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`) || []) {
      if ((!best || (AREA_PRIORITY[area.kind] || 0) > (AREA_PRIORITY[best.kind] || 0)) && contains([x, y], area.polygon) && !(area.holes || []).some((hole) => contains([x, y], hole))) best = area;
    }
    return best?.kind || 'unknown';
  }
  return {
    elevationStatus: elevation?.status || 'unknown',
    baselineAt: (x, y) => sampleElevation(elevation, x, y),
    heightAt(x, y, year = 2025, scenario = false) {
      const baseline = sampleElevation(elevation, x, y);
      if (baseline === null) return null;
      return baseline + (scenario ? scenarioHeightOffset(x, y, year, extent) : 0);
    },
    healthAt(x, y, year = 2025, ndviHealth = 1) {
      if (!numeric(x) || !numeric(y) || !numeric(ndviHealth)) return null;
      const health = clamp(ndviHealth, 0, 1);
      const patch = (Math.sin(x / 430 + sitePhase) * Math.cos(y / 510 - sitePhase) + 1) / 2;
      return clamp(health - (1 - health) * 0.24 * patch, 0, 1);
    },
    groundKindAt,
    scenarioAt: scenarioParameters,
  };
}
