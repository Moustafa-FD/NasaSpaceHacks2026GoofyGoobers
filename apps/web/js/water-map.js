// Water map: annual precipitation (mm/year) around a study site on one fixed scale, so wet and dry
// places compare directly. Past years are NASA MERRA-2 observations; future years scale the
// 2005-2024 observed pattern by the NASA POWER CMIP6 ensemble change at the site (delta change).
// Data: data/cloudshadow/watermaps/<site>.json (scripts/water_maps.py).

export const WATER_KIND = 'Water';
export const WATER_SCALE = Object.freeze({ min: 0, max: 1800, unit: 'mm/year' });
// Brown (dry) to teal (wet), ColorBrewer BrBG stops; strong at both ends so ~1000 vs ~1400 mm reads.
export const WATER_STOPS = Object.freeze([[0, [140, 81, 10]], [350, [216, 179, 101]], [700, [246, 232, 195]], [1000, [199, 234, 229]], [1300, [90, 180, 172]], [1800, [1, 102, 94]]]);

/** Same colour = same rainfall at every site. */
export function waterColor(mm) {
  if (!Number.isFinite(mm)) return [0, 0, 0, 0];
  const v = Math.max(WATER_SCALE.min, Math.min(WATER_SCALE.max, mm));
  let k = 1; while (k < WATER_STOPS.length - 1 && v > WATER_STOPS[k][0]) k++;
  const [a, ca] = WATER_STOPS[k - 1], [b, cb] = WATER_STOPS[k], t = (v - a) / (b - a || 1);
  return [...ca.map((c, i) => Math.round(c + (cb[i] - c) * t)), 235];
}

/** Values for one year: observed (complete years) or projected (normal x scenario factor). */
export function waterYear(doc, year, scenario = 'ssp245') {
  if (!doc?.grid) return null;
  const observed = doc.observed?.[String(year)];
  if (observed) return { kind: 'observed', year, values: observed };
  const years = Object.keys(doc.observed || {}).map(Number).sort((a, b) => a - b);
  const last = years.at(-1);
  if (year < years[0]) return { kind: 'observed', year: years[0], values: doc.observed[String(years[0])], note: `No precipitation map before ${years[0]}; showing ${years[0]}.` };
  const scen = doc.projection?.scenarios?.[scenario] || doc.projection?.scenarios?.ssp245;
  const factor = scen?.byYear?.[String(year)];
  if (year > last && Number.isFinite(factor)) {
    return { kind: 'projected', year, factor, scenarioLabel: scen.label, values: doc.normal.map((v) => (Number.isFinite(v) ? Math.round(v * factor) : null)) };
  }
  return { kind: 'observed', year: last, values: doc.observed[String(last)], note: `${year} is not complete yet; showing ${last}.` };
}

export function siteValue(doc, values) {
  const g = doc.grid, j = Math.floor(g.ny / 2), i = Math.floor(g.nx / 2);
  return values?.[j * g.nx + i] ?? null;
}

export function attachWaterMap(viewer, { eventTarget = window, fetchImpl = fetch } = {}) {
  const C = globalThis.Cesium, docs = new Map();
  let kind = null, layer = null, token = 0, scenario = 'ssp245';
  const $ = (s) => document.querySelector(s);
  const site = () => eventTarget.CloudShadow?.state?.site;
  const year = () => Number(eventTarget.CloudShadowTimeline?.year || $('#tlSlider')?.value || 2025);
  const load = (id) => {
    if (!docs.has(id)) {
      const task = fetchImpl(`data/watermaps/${encodeURIComponent(id)}.json`).then((r) => { if (!r.ok) throw new Error('no water map'); return r.json(); });
      docs.set(id, task); task.catch(() => docs.delete(id));
    }
    return docs.get(id);
  };
  const remove = () => { if (layer && viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true); layer = null; };
  function legend(doc, data, s) {
    const L = $('#mapLegend'); if (!L) return;
    const v = siteValue(doc, data.values), normal = siteValue(doc, doc.normal);
    const diff = Number.isFinite(v) && Number.isFinite(normal) && normal ? Math.round((v / normal - 1) * 100) : null;
    L.hidden = false; L.classList.toggle('map-projected', data.kind === 'projected');
    $('#mapLegendTitle').textContent = data.kind === 'projected' ? `Water · rainfall · PROJECTED ${data.year}` : `Water · rainfall · ${data.year}`;
    $('#mapLegendDetail').textContent = `${s.name}: ${Number.isFinite(v) ? v.toLocaleString('en-US') : '–'} mm/year${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff}% vs. 2005–2024 normal)` : ''}${data.note ? ` · ${data.note}` : ''}`;
    $('#mapColorScale').hidden = false; $('#mapLegendScale').hidden = true;
    $('#mapColorScale .evidence-ramp')?.classList.add('water');
    $('#mapScaleLow').textContent = '0'; $('#mapScaleHigh').textContent = `${WATER_SCALE.max.toLocaleString('en-US')} mm/year`;
    $('#mapScaleMeaning').textContent = 'Teal: wetter · brown: drier · same scale at every site';
    $('#mapResolution').textContent = data.kind === 'projected'
      ? `Climate scenario, not a forecast: the 2005–2024 NASA MERRA-2 rainfall pattern scaled by the NASA POWER CMIP6 ensemble (${data.scenarioLabel || 'SSP2-4.5'}) change at the site (×${data.factor.toFixed(3)}, 10-year mean). ~50 km cells.`
      : 'NASA MERRA-2 bias-corrected precipitation, calendar-year total from monthly means. ~50 km cells.';
    const status = $('#mapPlaybackStatus'); if (status) status.textContent = 'Map ready · same rainfall scale at every site.';
  }
  async function draw() {
    const t = ++token, s = site();
    if (kind !== WATER_KIND || !s) { remove(); $('#mapColorScale .evidence-ramp')?.classList.remove('water'); return; }
    let doc; try { doc = await load(s.id); } catch { remove(); return; }
    if (t !== token || kind !== WATER_KIND) return;
    const data = waterYear(doc, year(), scenario); if (!data) return;
    const g = doc.grid, canvas = document.createElement('canvas'); canvas.width = g.nx; canvas.height = g.ny;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(g.nx, g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      // grid rows run south to north; canvas rows run north to south
      img.data.set(waterColor(data.values[j * g.nx + i]), ((g.ny - 1 - j) * g.nx + i) * 4);
    }
    ctx.putImageData(img, 0, 0);
    const big = document.createElement('canvas'); big.width = g.nx * 16; big.height = g.ny * 16;
    const bctx = big.getContext('2d'); bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high'; bctx.drawImage(canvas, 0, 0, big.width, big.height);
    const rect = C.Rectangle.fromDegrees(g.lon0, g.lat0, g.lon0 + g.nx * g.dlon, g.lat0 + g.ny * g.dlat);
    const provider = await C.SingleTileImageryProvider.fromUrl(big.toDataURL('image/png'), { rectangle: rect });
    if (t !== token || kind !== WATER_KIND) return;
    const next = viewer.imageryLayers.addImageryProvider(provider);
    next.alpha = Math.max(0.8, Number($('#opacity')?.value || 0.85));
    remove(); layer = next;
    // after the app has hidden its own (GIBS) legend for this non-GIBS layer
    setTimeout(() => { if (t === token && kind === WATER_KIND) legend(doc, data, s); }, 0);
    viewer.scene.requestRender?.();
  }
  const onLayer = ({ detail }) => { kind = detail?.kind; setTimeout(draw, 0); };
  const onYear = () => { if (kind === WATER_KIND) draw(); };
  const onSite = () => { remove(); if (kind === WATER_KIND) setTimeout(draw, 300); };
  const onOptions = ({ detail }) => { if (['ssp126', 'ssp245', 'ssp370'].includes(detail?.powerScenario)) { scenario = detail.powerScenario; onYear(); } };
  eventTarget.addEventListener('cs:map-layer', onLayer);
  eventTarget.addEventListener('cs:year', onYear);
  eventTarget.addEventListener('cs:site', onSite);
  eventTarget.addEventListener('cs:future-options', onOptions);
  return { draw, get state() { return { kind, scenario, hasLayer: !!layer }; } };
}
