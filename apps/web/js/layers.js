// Cloud Shadow - NASA GIBS layers, colormap decoding and the live point sampler.
// Mirrors scripts/precompute.py so live results match the precomputed demos.

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

const VARS = {
  LST_Day: {
    noun: "daytime surface heat", label: "Surface heat (day)", short: "Day heat", unit: "°C", digits: 1,
    layer: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", cmap: "cm_MODIS_Land_Surface_Temp.xml",
    start: "2003-01-01", every: 1, ring: [6, 20], offset: -273.15, scale: 1, higherIsWorse: true,
    sensor: "MODIS / Terra · 8-day · ~1 km",
    define: "Land surface temperature: how hot the ground and roofs are (not the air), around 10:30 am. Roofs, pavement and bare dirt heat up more than fields and forest.",
  },
  LST_Night: {
    noun: "nighttime surface heat", label: "Surface heat (night)", short: "Night heat", unit: "°C", digits: 1,
    layer: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night", cmap: "cm_MODIS_Land_Surface_Temp.xml",
    start: "2003-01-01", every: 1, ring: [6, 20], offset: -273.15, scale: 1, higherIsWorse: true,
    sensor: "MODIS / Terra · 8-day · ~1 km",
    define: "The same measurement around 10:30 pm. Concrete gives off stored heat at night, and data centers run 24/7, so a warm night signal can be a fingerprint of industry.",
  },
  NDVI: {
    noun: "greenness (NDVI)", label: "Greenness (NDVI)", short: "Greenness", unit: "", digits: 2,
    layer: "MODIS_Terra_L3_NDVI_16Day", cmap: "cm_MODIS_L3_NDVI.xml",
    start: "2003-01-01", every: 1, ring: [4, 12], offset: 0, scale: 1, higherIsWorse: false,
    sensor: "MODIS / Terra · 16-day · ~250 m",
    define: "Normalized Difference Vegetation Index, from 0 (bare ground or roofs) to 1 (dense, healthy plants). It drops when land is cleared for construction.",
  },
  NO2: {
    noun: "NO₂", label: "Air: nitrogen dioxide (NO₂)", short: "NO₂", unit: "×10¹⁵ molec/cm²", digits: 2,
    layer: "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", cmap: "cm_OMI_Nitrogen_Dioxide_Tropo_Column.xml",
    start: "2023-09-01", every: 1, ring: [20, 50], offset: 0, scale: 1e-15, higherIsWorse: true,
    sensor: "Sentinel-5P TROPOMI · daily · ~5 km · in GIBS since Sep 2023",
    define: "Nitrogen dioxide in the air column above the ground. It comes from burning fuel in cars, power plants and gas turbines, and it helps form smog and ozone. Satellites see it as a 'plume' around big sources.",
  },
  NO2_OMI: {
    noun: "NO₂ (OMI)", label: "Air: NO₂, 20-year record (OMI)", short: "NO₂ (OMI)", unit: "×10¹⁵ molec/cm²", digits: 2,
    layer: "OMI_Nitrogen_Dioxide_Tropo_Column", cmap: "cm_OMI_Nitrogen_Dioxide_Tropo_Column.xml",
    start: "2005-01-01", every: 3, ring: [30, 70], offset: 0, scale: 1e-15, higherIsWorse: true,
    sensor: "NASA Aura OMI · daily · ~13×24 km · 2004–today",
    define: "The same gas, measured by NASA's OMI instrument since 2004. It's much coarser (a pixel covers a whole neighborhood) but long enough to see 20-year trends. US NO₂ has mostly fallen thanks to cleaner cars and power plants, so a site bucking that trend stands out.",
  },
  AOD: {
    noun: "particle pollution (AOD)", label: "Air: particles / haze (AOD)", short: "Particles", unit: "", digits: 3,
    layer: "MODIS_Terra_Aerosol_Optical_Depth_3km", cmap: "cm_MODIS_VIIRS_AOD.xml",
    start: "2003-01-01", every: 3, ring: [15, 40], win: 2, minSite: 3, offset: 0, scale: 1, higherIsWorse: true,
    sensor: "MODIS / Terra · daily · 3 km · 2000–today",
    define: "Aerosol optical depth: how much sunlight is blocked by particles in the air (smoke, soot, dust, sulfate haze). Gas turbines and diesel backup generators add fine particles (PM2.5). 0.1 is clean air; above 0.5 is hazy.",
  },
  AirTemp: {
    noun: "regional air temperature", label: "Weather: regional air temperature", short: "Air temp", unit: "°C", digits: 2,
    layer: "MERRA2_2m_Air_Temperature_Monthly", cmap: "cm_MERRA2_2m_Air_Temperature_Monthly.xml",
    start: "2003-01-01", every: 1, ring: [80, 200], offset: -273.15, scale: 1, higherIsWorse: true,
    sensor: "NASA MERRA-2 reanalysis · monthly · ~50 km",
    define: "Air temperature 2 m above the ground from NASA's MERRA-2 weather reanalysis. A pixel is ~50 km wide, so this is the regional climate, our control. If the whole region warms, that isn't the data center; if the site's surface heat rises faster than the region's air, that's a local signal.",
  },
};

// Extra map-only layers (no time series)
const MAP_LAYERS = {
  HLS: { label: "True color · 30 m (Landsat/Sentinel HLS)", define: "Harmonized Landsat + Sentinel-2 surface reflectance. You can see individual buildings and cleared land." },
  DIST: { label: "Land disturbance (OPERA, yearly)", layer: "OPERA_L3_DIST-ANN-HLS_Color_Index", define: "NASA OPERA flags 30 m pixels where vegetation was lost that year (construction, clearing, fire)." },
};

let CATALOG = null;
const _dateCache = {};
async function loadCatalog() {
  if (!CATALOG) CATALOG = await (await fetch("data/gibs_layers.json")).json();
  return CATALOG;
}

const iso = (d) => d.toISOString().slice(0, 10);
function expandIntervals(layer, start) {
  const key = layer + (start || "");
  if (_dateCache[key]) return _dateCache[key];
  const out = [];
  for (const iv of CATALOG[layer].intervals) {
    const [a, b, per] = iv.split("/");
    let d = new Date(a.slice(0, 10) + "T00:00:00Z"); const end = new Date(b.slice(0, 10) + "T00:00:00Z");
    const n = parseInt(per.replace(/\D/g, ""), 10), unit = per.slice(-1);
    while (d <= end) {
      out.push(iso(d));
      d = new Date(d);
      if (unit === "D") d.setUTCDate(d.getUTCDate() + n);
      else if (unit === "M") d.setUTCMonth(d.getUTCMonth() + n);
      else if (unit === "Y") d.setUTCFullYear(d.getUTCFullYear() + n);
    }
  }
  const s = [...new Set(out)].sort().filter((x) => !start || x >= start);
  return (_dateCache[key] = s);
}

// Snap any date to the closest available one for a layer
function snapDate(layer, want) {
  const ds = expandIntervals(layer);
  let best = ds[0], bd = Infinity; const w = Date.parse(want);
  for (const d of ds) { const k = Math.abs(Date.parse(d) - w); if (k < bd) { bd = k; best = d; } }
  return best;
}

function tileUrl(layer, date) {
  const tms = CATALOG[layer].tms;
  return `${GIBS}/${layer}/default/${date}/${tms}/{z}/{y}/{x}.png`;
}

// ---------------------------------------------------------------- colormaps
const _luts = {};
async function loadLut(file) {
  if (_luts[file]) return _luts[file];
  const xml = new DOMParser().parseFromString(await (await fetch("data/" + file)).text(), "text/xml");
  const lut = new Map();
  for (const e of xml.getElementsByTagName("ColorMapEntry")) {
    if (e.getAttribute("transparent") === "true" || e.getAttribute("nodata") === "true" || !e.getAttribute("value")) continue;
    let [lo, hi] = e.getAttribute("value").replace(/[\[\]()]/g, "").split(",").map((s) => parseFloat(s.trim().replace("+INF", "Infinity").replace("-INF", "-Infinity")));
    if (hi === undefined || isNaN(hi)) hi = lo; // single-value entries like "[5]"
    const v = !isFinite(lo) ? hi : !isFinite(hi) ? lo : (lo + hi) / 2;
    const [r, g, b] = e.getAttribute("rgb").split(",").map(Number);
    lut.set((r << 16) | (g << 8) | b, v);
  }
  return (_luts[file] = lut);
}

// ---------------------------------------------------------------- geometry
function worldPx(lat, lon, z) {
  const n = 256 * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
const mPerPx = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

function samplePlan(lat, lon, z, ring, win = 1) {
  let [cx, cy] = worldPx(lat, lon, z); cx = Math.floor(cx); cy = Math.floor(cy);
  const site = []; for (let dx = -win; dx <= win; dx++) for (let dy = -win; dy <= win; dy++) site.push([cx + dx, cy + dy]);
  const mpp = mPerPx(lat, z), r0 = (ring[0] * 1000) / mpp, r1 = (ring[1] * 1000) / mpp, R = Math.ceil(r1), step = Math.max(1, Math.floor(R / 30));
  const ref = [];
  for (let dx = -R; dx <= R; dx += step) for (let dy = -R; dy <= R; dy += step) { const h = Math.hypot(dx, dy); if (h >= r0 && h <= r1) ref.push([cx + dx, cy + dy]); }
  return { site, ref };
}

// ---------------------------------------------------------------- tile pixels
const _tiles = new Map();
function loadTilePixels(url) {
  if (_tiles.has(url)) return _tiles.get(url);
  const p = new Promise((resolve) => {
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0);
      try { resolve(ctx.getImageData(0, 0, 256, 256).data); } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  _tiles.set(url, p);
  return p;
}

async function decodePoints(layer, date, z, pts, lut) {
  const tms = CATALOG[layer].tms, byTile = new Map();
  for (const [gx, gy] of pts) {
    const k = `${Math.floor(gy / 256)}/${Math.floor(gx / 256)}`;
    if (!byTile.has(k)) byTile.set(k, []);
    byTile.get(k).push([((gx % 256) + 256) % 256, ((gy % 256) + 256) % 256]);
  }
  const vals = [];
  await Promise.all([...byTile].map(async ([k, pix]) => {
    const data = await loadTilePixels(`${GIBS}/${layer}/default/${date}/${tms}/${z}/${k}.png`);
    if (!data) return;
    for (const [x, y] of pix) {
      const i = (y * 256 + x) * 4; if (data[i + 3] === 0) continue;
      const v = lut.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (v !== undefined) vals.push(v);
    }
  }));
  return vals;
}

// Live time series for any point on Earth. onProgress(done, total)
async function sampleSeries(lat, lon, varId, { stride = 1, since, onProgress, signal } = {}) {
  await loadCatalog();
  const v = VARS[varId], lut = await loadLut(v.cmap), z = CATALOG[v.layer].z;
  const plan = samplePlan(lat, lon, z, v.ring, v.win ?? 1);
  const dates = expandIntervals(v.layer, since || v.start).filter((_, i) => i % (v.every * stride) === 0);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const rows = new Array(dates.length); let done = 0, next = 0;
  async function worker() {
    while (next < dates.length) {
      if (signal?.aborted) return;
      const i = next++, d = dates[i];
      const [s, r] = await Promise.all([decodePoints(v.layer, d, z, plan.site, lut), decodePoints(v.layer, d, z, plan.ref, lut)]);
      rows[i] = [d, s.length >= (v.minSite ?? Math.ceil(plan.site.length / 2)) ? avg(s) : null, r.length >= Math.max(5, plan.ref.length / 4) ? avg(r) : null];
      onProgress?.(++done, dates.length);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  // to calendar months
  const agg = new Map();
  for (const row of rows) {
    if (!row) continue; const k = row[0].slice(0, 7);
    if (!agg.has(k)) agg.set(k, [[], []]);
    if (row[1] != null) agg.get(k)[0].push(row[1]);
    if (row[2] != null) agg.get(k)[1].push(row[2]);
  }
  const t = [...agg.keys()].sort();
  const conv = (x) => (x == null ? null : +((x + v.offset) * v.scale).toFixed(4));
  return { t, site: t.map((k) => conv(agg.get(k)[0].length ? avg(agg.get(k)[0]) : null)), ref: t.map((k) => conv(agg.get(k)[1].length ? avg(agg.get(k)[1]) : null)) };
}
