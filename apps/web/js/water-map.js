// Water map: yearly rainfall worldwide from NASA MERRA-2 (scripts/water_global.py), drawn as one
// image over the globe. 2003-2025: with "Show change" on (default) each cell is coloured by how much
// wetter or drier that year was than its own 2005-2024 normal; off, absolute mm/year on one scale.
// 2027-2035: each cell's own measured 2003-2025 trend continued (Sen's slope, Mann-Kendall +
// Hamed-Rao, Benjamini-Hochberg q < 0.10); cells without a significant trend are not coloured.
// After 2035 there is no water map: a 23-year trend line is not extended further.

export const WATER_KIND = 'Water';
export const WATER_SCALE = Object.freeze({ min: 0, max: 1800, unit: 'mm/year' });
export const ANOMALY_RANGE = 25; // ± % of the 2005-2024 normal at full colour
// Brown (dry) to teal (wet), ColorBrewer BrBG stops.
export const WATER_STOPS = Object.freeze([[0, [140, 81, 10]], [350, [216, 179, 101]], [700, [246, 232, 195]], [1000, [199, 234, 229]], [1300, [90, 180, 172]], [1800, [1, 102, 94]]]);

/** Same colour = same rainfall everywhere. */
export function waterColor(mm) {
  if (!Number.isFinite(mm)) return [0, 0, 0, 0];
  const v = Math.max(WATER_SCALE.min, Math.min(WATER_SCALE.max, mm));
  let k = 1; while (k < WATER_STOPS.length - 1 && v > WATER_STOPS[k][0]) k++;
  const [a, ca] = WATER_STOPS[k - 1], [b, cb] = WATER_STOPS[k], t = (v - a) / (b - a || 1);
  return [...ca.map((c, i) => Math.round(c + (cb[i] - c) * t)), 225];
}
/** Wetter or drier than normal: brown = drier, teal = wetter. */
export function anomalyColor(pct) {
  if (!Number.isFinite(pct)) return [0, 0, 0, 0];
  const t = Math.max(-1, Math.min(1, pct / ANOMALY_RANGE)), end = t < 0 ? [140, 81, 10] : [1, 102, 94], w = Math.abs(t), mid = [246, 246, 238];
  return [...mid.map((c, i) => Math.round(c + (end[i] - c) * w)), Math.round(70 + 165 * w)];
}

/** What a year shows: an observed grid, the trend projection (to 2035), or nothing after that. */
export function waterPlan(index, year) {
  const years = index?.years || [], first = years[0], last = years.at(-1), through = index?.trend?.projectionThrough ?? 2035;
  if (years.includes(year)) return { kind: 'observed', file: `${year}.png`, year };
  if (year < first) return { kind: 'observed', file: `${first}.png`, year: first, note: `No rainfall map before ${first}; showing ${first}.` };
  if (year <= last + 1) return { kind: 'observed', file: `${last}.png`, year: last, note: `${year} is not complete yet; showing ${last}.` };
  if (year <= through) return { kind: 'projected', file: 'normal.png', year, through };
  return { kind: 'none', year, through };
}
/** Rainfall for a projected year from the cell's normal and its trend line; null without a significant trend. */
export function projectedRain(normal, slope, year, centre = 2014.5) {
  if (!Number.isFinite(normal) || !Number.isFinite(slope) || slope === 0) return null;
  return Math.max(0, normal + slope * (year - centre));
}

export function attachWaterMap(viewer, { eventTarget = window, fetchImpl = fetch } = {}) {
  const C = globalThis.Cesium, grids = new Map();
  let kind = null, layer = null, token = 0, indexTask = null;
  const $ = (s) => document.querySelector(s);
  const site = () => eventTarget.CloudShadow?.state?.site;
  const year = () => Number(eventTarget.CloudShadowTimeline?.year || $('#tlSlider')?.value || 2025);
  const index = () => (indexTask ??= fetchImpl('data/watermaps/global/index.json').then((r) => { if (!r.ok) throw new Error('no global water index'); return r.json(); }).catch((e) => { indexTask = null; throw e; }));
  const decodeRain = (ix) => (v) => (v === ix.nodata ? NaN : v * ix.step);
  // trend.png: (level - zero) x step mm/year per year; level zero = no significant trend
  const decodeTrend = (ix) => (v) => (v === ix.trend.nodata ? NaN : (v - ix.trend.zero) * ix.trend.step);
  function grid(file, decode) {
    if (!grids.has(file)) {
      const task = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, img.width, img.height).data, out = new Float32Array(img.width * img.height);
          for (let k = 0; k < out.length; k++) out[k] = decode(px[k * 4]);
          resolve(out);
        };
        img.onerror = () => reject(new Error('water grid unavailable'));
        img.src = `data/watermaps/global/${file}`;
      });
      grids.set(file, task); task.catch(() => grids.delete(file));
      while (grids.size > 8) grids.delete(grids.keys().next().value);
    }
    return grids.get(file);
  }
  const remove = () => { if (layer && viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true); layer = null; };
  const cellOf = (ix, lat, lon) => {
    const g = ix.grid, j = Math.round((90 - lat) / g.dlat), i = Math.round((lon + 180) / g.dlon);
    return j >= 0 && j < g.ny && i >= 0 && i < g.nx ? j * g.nx + i : -1;
  };
  const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–');
  function noPrediction(plan) {
    const L = $('#mapLegend'); if (!L) return;
    L.hidden = false; L.classList.remove('map-projected');
    $('#mapLegendTitle').textContent = `Water · no rainfall prediction for ${plan.year}`;
    $('#mapLegendDetail').textContent = `The water map extends measured rainfall trends only to ${plan.through}. A 23-year trend line says nothing reliable beyond that.`;
    $('#mapColorScale').hidden = true;
    $('#mapResolution').textContent = 'For 2036–2100 see the regional climate scenarios (NASA NEX-GDDP-CMIP6) in the panel.';
    const status = $('#mapPlaybackStatus'); if (status) status.textContent = 'No water map for this year.';
  }
  function legend({ plan, s, change, value, normal, slope, sigShare }) {
    const L = $('#mapLegend'); if (!L) return;
    const projected = plan.kind === 'projected';
    const diff = Number.isFinite(value) && Number.isFinite(normal) && normal ? Math.round((value / normal - 1) * 100) : null;
    L.hidden = false; L.classList.toggle('map-projected', projected);
    $('#mapLegendTitle').textContent = projected ? `Water · rainfall · PROJECTED ${plan.year}` : `Water · rainfall · ${plan.year}`;
    const name = s?.name || 'Site';
    $('#mapLegendDetail').textContent = projected && !slope
      ? `${name}: no significant rainfall trend here, so no projection (normal ${fmt(normal)} mm/year).`
      : `${name}: ${fmt(value)} mm/year${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff}% vs. 2005–2024 normal)` : ''}${projected ? ` if its ${slope > 0 ? '+' : ''}${Math.round(slope * 10)} mm/decade trend continues` : ''}${plan.note ? ` · ${plan.note}` : ''}`;
    $('#mapColorScale').hidden = false; $('#mapLegendScale').hidden = true;
    const ramp = $('#mapColorScale .evidence-ramp'); ramp?.classList.toggle('water', !change); ramp?.classList.toggle('water-change', change);
    $('#mapScaleLow').textContent = change ? `−${ANOMALY_RANGE}%` : '0';
    $('#mapScaleHigh').textContent = change ? `+${ANOMALY_RANGE}% vs. normal` : `${WATER_SCALE.max.toLocaleString('en-US')} mm/year`;
    $('#mapScaleMeaning').textContent = !change ? 'Teal: wetter · brown: drier · same mm scale everywhere'
      : projected ? 'Teal: trend making it wetter than its 2005–2024 normal · brown: drier · clear: no significant trend'
        : 'Teal: wetter than its 2005–2024 normal that year · brown: drier';
    $('#mapResolution').textContent = projected
      ? `Trend extension, not a forecast: each cell continues its own 2003–2025 NASA MERRA-2 rainfall trend (Sen's slope; Mann-Kendall, Hamed-Rao; false-discovery q < 0.10). ${sigShare}% of cells worldwide have a significant trend; the rest are left clear. No water map after ${plan.through}.`
      : 'NASA MERRA-2 bias-corrected precipitation, calendar-year totals from monthly means, worldwide on a ~50 km grid.';
    const status = $('#mapPlaybackStatus'); if (status) status.textContent = 'Map ready · worldwide rainfall.';
  }
  async function draw() {
    const t = ++token, s = site();
    if (kind !== WATER_KIND) { remove(); $('#mapColorScale .evidence-ramp')?.classList.remove('water', 'water-change'); return; }
    let ix; try { ix = await index(); } catch { remove(); return; }
    const plan = waterPlan(ix, year()), change = $('#mapChange')?.checked !== false;
    if (plan.kind === 'none') { remove(); setTimeout(() => { if (t === token && kind === WATER_KIND) noPrediction(plan); }, 0); return; }
    const projected = plan.kind === 'projected';
    let values, normal, trend;
    try {
      [values, normal, trend] = await Promise.all([grid(plan.file, decodeRain(ix)), grid('normal.png', decodeRain(ix)), projected ? grid(ix.trend.file, decodeTrend(ix)) : null]);
    } catch { remove(); return; }
    if (t !== token || kind !== WATER_KIND) return;
    const g = ix.grid, centre = ix.trend?.lineCentreYear ?? 2014.5;
    const rows = g.ny - 2, canvas = document.createElement('canvas'); canvas.width = g.nx; canvas.height = rows; // drop the two polar rows
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(g.nx, rows);
    let sig = 0, all = 0;
    for (let j = 1; j < g.ny - 1; j++) for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      let v = values[k];
      if (projected) {
        if (Number.isFinite(trend[k])) all++;
        const p = projectedRain(normal[k], trend[k], plan.year, centre);
        if (p != null) sig++;
        // Only cells with a significant trend get a projection; the rest stay clear (change view) or at their normal.
        v = p ?? (change ? NaN : normal[k]);
      }
      const color = change ? anomalyColor(Number.isFinite(v) && normal[k] > 0 ? (v / normal[k] - 1) * 100 : NaN) : waterColor(v);
      img.data.set(color, ((j - 1) * g.nx + i) * 4);
    }
    ctx.putImageData(img, 0, 0);
    const big = document.createElement('canvas'); big.width = g.nx * 4; big.height = rows * 4;
    const bctx = big.getContext('2d'); bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high'; bctx.drawImage(canvas, 0, 0, big.width, big.height);
    const provider = await C.SingleTileImageryProvider.fromUrl(big.toDataURL('image/png'), { rectangle: C.Rectangle.fromDegrees(-180, -90 + g.dlat * 1.5, 180, 90 - g.dlat * 1.5) });
    if (t !== token || kind !== WATER_KIND) return;
    const next = viewer.imageryLayers.addImageryProvider(provider);
    next.alpha = Math.max(0.75, Number($('#opacity')?.value || 0.85));
    remove(); layer = next;
    const k = s ? cellOf(ix, s.lat, s.lon) : -1, slope = projected && k >= 0 && trend[k] ? trend[k] : 0;
    const value = k < 0 ? NaN : projected ? (projectedRain(normal[k], trend[k], plan.year, centre) ?? normal[k]) : values[k];
    const sigShare = all ? Math.round((sig / all) * 100) : 0;
    setTimeout(() => { if (t === token && kind === WATER_KIND) legend({ plan, s, change, value, normal: k >= 0 ? normal[k] : NaN, slope, sigShare }); }, 0);
    viewer.scene.requestRender?.();
  }
  const onLayer = ({ detail }) => { kind = detail?.kind; setTimeout(draw, 0); };
  const onYear = () => { if (kind === WATER_KIND) draw(); };
  const onSite = () => { if (kind === WATER_KIND) setTimeout(draw, 300); };
  eventTarget.addEventListener('cs:map-layer', onLayer);
  eventTarget.addEventListener('cs:year', onYear);
  eventTarget.addEventListener('cs:site', onSite);
  return { draw, get state() { return { kind, hasLayer: !!layer }; } };
}
