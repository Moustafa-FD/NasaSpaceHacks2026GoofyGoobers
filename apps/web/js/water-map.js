// Water map: yearly rainfall worldwide from NASA MERRA-2 (scripts/water_global.py), drawn as one
// image over the globe. Past years (2003-2025): with "Show change" on (default) each cell is coloured
// by how much wetter or drier that year was than its own 2005-2024 normal; off, absolute mm/year on
// one scale. Future years: the 2005-2024 normal in mm/year, with the study-site area scaled by the
// NASA POWER CMIP6 ensemble change at the site (data/cloudshadow/watermaps/<site>.json). Climate
// projections exist only at the study sites, so the rest of the world shows the normal.

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

/** Which grid a year uses: an observed year, or the normal for projected years. */
export function waterPlan(index, year) {
  const years = index?.years || [], first = years[0], last = years.at(-1);
  if (years.includes(year)) return { kind: 'observed', file: `${year}.png`, year };
  if (year < first) return { kind: 'observed', file: `${first}.png`, year: first, note: `No rainfall map before ${first}; showing ${first}.` };
  if (year <= 2026) return { kind: 'observed', file: `${last}.png`, year: last, note: `${year} is not complete yet; showing ${last}.` };
  return { kind: 'projected', file: 'normal.png', year };
}
/** CMIP6 ensemble factor for the study site (1 = no change), 10-year mean. */
export function siteFactor(siteDoc, year, scenario = 'ssp245') {
  const scen = siteDoc?.projection?.scenarios?.[scenario] || siteDoc?.projection?.scenarios?.ssp245;
  const f = scen?.byYear?.[String(year)];
  return Number.isFinite(f) ? { factor: f, label: scen.label } : null;
}

export function attachWaterMap(viewer, { eventTarget = window, fetchImpl = fetch } = {}) {
  const C = globalThis.Cesium, grids = new Map(), sites = new Map();
  let kind = null, layer = null, token = 0, scenario = 'ssp245', indexTask = null;
  const $ = (s) => document.querySelector(s);
  const site = () => eventTarget.CloudShadow?.state?.site;
  const year = () => Number(eventTarget.CloudShadowTimeline?.year || $('#tlSlider')?.value || 2025);
  const index = () => (indexTask ??= fetchImpl('data/watermaps/global/index.json').then((r) => { if (!r.ok) throw new Error('no global water index'); return r.json(); }).catch((e) => { indexTask = null; throw e; }));
  const siteDoc = (id) => { if (!sites.has(id)) sites.set(id, fetchImpl(`data/watermaps/${encodeURIComponent(id)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)); return sites.get(id); };
  function grid(file, ix) {
    if (!grids.has(file)) {
      const task = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, img.width, img.height).data, out = new Float32Array(img.width * img.height);
          for (let k = 0; k < out.length; k++) { const v = px[k * 4]; out[k] = v === ix.nodata ? NaN : v * ix.step; }
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
  function legend({ plan, s, change, value, normal, scaled }) {
    const L = $('#mapLegend'); if (!L) return;
    const diff = Number.isFinite(value) && Number.isFinite(normal) && normal ? Math.round((value / normal - 1) * 100) : null;
    const projected = plan.kind === 'projected', anomalyView = change && !projected;
    L.hidden = false; L.classList.toggle('map-projected', projected);
    $('#mapLegendTitle').textContent = projected ? `Water · rainfall · PROJECTED ${plan.year}` : `Water · rainfall · ${plan.year}`;
    $('#mapLegendDetail').textContent = `${s?.name || 'Site'}: ${Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '–'} mm/year${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff}% vs. 2005–2024 normal)` : ''}${plan.note ? ` · ${plan.note}` : ''}`;
    $('#mapColorScale').hidden = false; $('#mapLegendScale').hidden = true;
    const ramp = $('#mapColorScale .evidence-ramp'); ramp?.classList.toggle('water', !anomalyView); ramp?.classList.toggle('water-change', anomalyView);
    $('#mapScaleLow').textContent = anomalyView ? `−${ANOMALY_RANGE}%` : '0';
    $('#mapScaleHigh').textContent = anomalyView ? `+${ANOMALY_RANGE}% vs. normal` : `${WATER_SCALE.max.toLocaleString('en-US')} mm/year`;
    $('#mapScaleMeaning').textContent = anomalyView ? 'Teal: wetter than its 2005–2024 normal that year · brown: drier' : 'Teal: wetter · brown: drier · same mm scale everywhere';
    $('#mapResolution').textContent = projected
      ? `Climate scenario, not a forecast. Worldwide: the 2005–2024 NASA MERRA-2 normal. Around ${s?.name || 'the study site'}: scaled by the NASA POWER CMIP6 ensemble (${scaled?.label || 'SSP2-4.5'}) change, ×${(scaled?.factor ?? 1).toFixed(3)} (10-year mean). Projections exist only at the study sites.`
      : 'NASA MERRA-2 bias-corrected precipitation, calendar-year totals from monthly means, worldwide on a ~50 km grid.';
    const status = $('#mapPlaybackStatus'); if (status) status.textContent = 'Map ready · worldwide rainfall.';
  }
  async function draw() {
    const t = ++token, s = site();
    if (kind !== WATER_KIND) { remove(); $('#mapColorScale .evidence-ramp')?.classList.remove('water', 'water-change'); return; }
    let ix; try { ix = await index(); } catch { remove(); return; }
    const plan = waterPlan(ix, year()), change = $('#mapChange')?.checked !== false;
    let values, normal;
    try { [values, normal] = await Promise.all([grid(plan.file, ix), grid('normal.png', ix)]); } catch { remove(); return; }
    if (t !== token || kind !== WATER_KIND) return;
    const g = ix.grid, doc = s ? await siteDoc(s.id) : null, scaled = plan.kind === 'projected' ? siteFactor(doc, plan.year, scenario) : null;
    if (t !== token || kind !== WATER_KIND) return;
    // Future: scale the study-site box (the same box as its CMIP6 factor) by that factor.
    const box = scaled && doc?.grid ? { s: doc.grid.lat0, n: doc.grid.lat0 + doc.grid.ny * doc.grid.dlat, w: doc.grid.lon0, e: doc.grid.lon0 + doc.grid.nx * doc.grid.dlon } : null;
    const rows = g.ny - 2, canvas = document.createElement('canvas'); canvas.width = g.nx; canvas.height = rows; // drop the two polar rows
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(g.nx, rows), anomalyView = change && plan.kind === 'observed';
    for (let j = 1; j < g.ny - 1; j++) for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i, lat = 90 - j * g.dlat, lon = -180 + i * g.dlon;
      let v = values[k];
      if (box && lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e) v *= scaled.factor;
      const color = anomalyView ? anomalyColor(Number.isFinite(v) && normal[k] > 0 ? (v / normal[k] - 1) * 100 : NaN) : waterColor(v);
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
    const k = s ? cellOf(ix, s.lat, s.lon) : -1;
    const value = k >= 0 ? values[k] * (scaled?.factor ?? 1) : NaN;
    setTimeout(() => { if (t === token && kind === WATER_KIND) legend({ plan, s, change, value, normal: k >= 0 ? normal[k] : NaN, scaled }); }, 0);
    viewer.scene.requestRender?.();
  }
  const onLayer = ({ detail }) => { kind = detail?.kind; setTimeout(draw, 0); };
  const onYear = () => { if (kind === WATER_KIND) draw(); };
  const onSite = () => { if (kind === WATER_KIND) setTimeout(draw, 300); };
  const onOptions = ({ detail }) => { if (['ssp126', 'ssp245', 'ssp370'].includes(detail?.powerScenario)) { scenario = detail.powerScenario; onYear(); } };
  eventTarget.addEventListener('cs:map-layer', onLayer);
  eventTarget.addEventListener('cs:year', onYear);
  eventTarget.addEventListener('cs:site', onSite);
  eventTarget.addEventListener('cs:future-options', onOptions);
  return { draw, get state() { return { kind, scenario, hasLayer: !!layer }; } };
}
