// One electricity card for the nearest mapped city. Prices are EIA state
// averages, not local tariffs or a data-center-attributed increase. A card stays
// at the real city center when visible; an explicitly labelled edge pin keeps
// it accessible from the campus without moving the camera or relocating a city.
import { loadElectricityData, nearestElectricityCity, electricitySnapshot } from './electricity-data.js';
import { loadWaterPriceData, waterPriceSnapshot } from './water-price-data.js';

export const ELECTRICITY_CHANGE_RANGE = 50;
export const ELECTRICITY_CITY_LIMIT = 1;
const TRANSITION_MS = 600;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const money = (n) => finite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : '—';
const price = (n) => finite(n) ? `${n.toFixed(2)}¢/kWh` : 'Price unavailable';
const signed = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const overlaps = (a, b, gap = 8) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/** Fixed signed scale; missing evidence never becomes a zero-price estimate. */
export function electricityChangeColor(pct) {
  if (!finite(pct)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.abs(pct) / ELECTRICITY_CHANGE_RANGE);
  const neutral = [239, 229, 207], end = pct < 0 ? [45, 131, 199] : [218, 67, 36];
  return [...neutral.map((n, i) => Math.round(n + (end[i] - n) * t)), Math.round(60 + 100 * t)];
}
export function blendElectricityColor(from, to, fraction) {
  const t = Math.max(0, Math.min(1, fraction)), eased = t * t * (3 - 2 * t);
  return to.map((n, i) => from[i] + (n - from[i]) * eased);
}
export function layoutElectricityCards(candidates, { width, height, obstacles = [], maxCards = ELECTRICITY_CITY_LIMIT } = {}) {
  const kept = [], boxes = [...obstacles];
  for (const item of candidates) {
    if (!finite(item.x) || !finite(item.y)) continue;
    const w = item.width ?? 224, h = item.height ?? 112, box = { x: item.x - w / 2, y: item.y - h - 18, w, h };
    if (box.x < 12 || box.y < 78 || box.x + w > width - 12 || box.y + h > height - 12 || boxes.some((b) => overlaps(box, b))) continue;
    boxes.push(box); kept.push({ ...item, left: box.x, top: box.y });
    if (kept.length >= maxCards) break;
  }
  return kept;
}

/** Fit the same single card around primary controls when its anchor is offscreen. */
export function placeElectricityInfoBox({ width, height, boxWidth, boxHeight, obstacles = [], preferredX = 110, preferredY = height - boxHeight - 24 }) {
  const gap = 12, xs = [preferredX, gap, width - boxWidth - gap], ys = [preferredY, height - boxHeight - 24, 82];
  for (const b of obstacles) { xs.push(b.x + b.w + gap, b.x - boxWidth - gap); ys.push(b.y - boxHeight - gap, b.y + b.h + gap); }
  const candidates = [];
  for (const x of xs) for (const y of ys) {
    const box = { x, y, w: boxWidth, h: boxHeight };
    if (x < gap || y < 78 || x + boxWidth > width - gap || y + boxHeight > height - gap || obstacles.some((b) => overlaps(box, b))) continue;
    candidates.push({ ...box, score: Math.abs(x - preferredX) + Math.abs(y - preferredY) * 2 });
  }
  candidates.sort((a, b) => a.score - b.score); return candidates[0] ?? null;
}

export function electricityCardText(city, snapshot) {
  const year = Number.isInteger(snapshot.year) ? String(snapshot.year) : Number(snapshot.year).toFixed(1);
  const phase = snapshot.kind === 'projected' ? 'Estimate' : snapshot.kind === 'unavailable' ? 'Unavailable' : 'Recorded';
  const available = snapshot.kind !== 'unavailable' && finite(snapshot.priceCentsKwh);
  const before = finite(snapshot.baselineBillUsd) ? `${snapshot.baselineYear}: ${money(snapshot.baselineBillUsd)}/mo` : 'Before: no record';
  const comparison = available && finite(snapshot.changePct) ? `${signed(snapshot.changePct)} price` : 'No price comparison';
  return { title: `${city.name} · ${city.state}`, bill: available ? `${money(snapshot.monthlyBillUsd)}/mo · ${year}` : `No price for ${year}`,
    before, comparison, detail: `${before} · ${comparison}`, provenance: `${available ? price(snapshot.priceCentsKwh) : 'No estimate'} · ${phase.toLowerCase()} · state avg` };
}

export function waterPriceCardText(city, snapshot, year) {
  const available = ['reported', 'reference'].includes(snapshot?.kind) && finite(snapshot?.monthlyBillUsd);
  const bill = available ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(snapshot.monthlyBillUsd) : null;
  const gallons = finite(snapshot?.monthlyGallons) ? snapshot.monthlyGallons : 3000;
  return {
    title: `${city.name} · ${city.state}`,
    bill: available ? `${bill}/mo*` : 'No published water price',
    detail: `${gallons.toLocaleString('en-US')} gal/month example · water only`,
    provenance: available ? (!finite(snapshot.rateYear) ? 'Published rate · date unspecified · reference only' : `Published ${snapshot.rateYear} rate · ${snapshot.kind === 'reference' ? `reference, not a ${Math.floor(year)} ${year < snapshot.rateYear ? 'record' : 'forecast'}` : 'reported rate'}`) : 'No historical or future bill estimate',
  };
}

function addStyle(document) {
  const style = document.createElement('style');
  style.textContent = `
    .electricity-map-overlay{position:absolute;inset:0;pointer-events:none;z-index:11;overflow:hidden;font-family:var(--sans,system-ui,sans-serif)}
    .electricity-map-overlay[hidden],.electricity-city-card[hidden]{display:none!important}
    .electricity-city-card{position:absolute;width:238px;box-sizing:border-box;text-align:left;padding:0;border:1px solid #b4b3a4;border-top:4px solid var(--electricity-color,#ddd);border-radius:9px;background:#fffdf5f5;color:#1b2727;box-shadow:0 4px 14px #0004;pointer-events:auto;line-height:1.3;font-family:inherit}
    .electricity-city-details{display:block;width:100%;border:0;background:transparent;text-align:left;font:inherit;color:inherit;padding:7px 12px 10px;cursor:pointer}
    .electricity-city-details:focus-visible,.city-cost-kind:focus-visible{outline:3px solid #e3a234;outline-offset:2px}
    .city-cost-switch{display:flex;gap:3px;margin:5px 6px 0;padding:2px;background:#e9e8dd;border-radius:5px}
    .city-cost-kind{flex:1;min-height:25px;padding:3px 6px;border:0;border-radius:4px;background:transparent;color:#435653;font:600 12px var(--sans,system-ui,sans-serif);cursor:pointer}
    .city-cost-kind[aria-pressed="true"]{background:#fffef9;color:#183b42;box-shadow:0 1px 3px #0002}
    .electricity-city-card[data-location-mode="city"]::after{content:"";position:absolute;bottom:-9px;left:calc(50% - 8px);width:13px;height:13px;background:#fffdf5;transform:rotate(45deg);border-right:1px solid #b4b3a4;border-bottom:1px solid #b4b3a4}
    .electricity-city-name{display:block;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .electricity-city-bill{display:block;font-size:22px;font-weight:750;letter-spacing:-.5px;margin:3px 0}
    .electricity-city-detail{display:block;font-size:12px;color:#425553}
    .electricity-city-meta{display:block;font-size:11px;color:#5f6d65;margin-top:4px}
    @media(max-width:680px){.electricity-city-card{width:216px}.electricity-city-bill{font-size:20px}}
  `;
  document.head.appendChild(style); return style;
}
function softDisc(document) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  for (const [stop, alpha] of [[0, .95], [.45, .75], [.82, .28], [1, 0]]) gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128); return canvas;
}
export function electricityCityDirection(site, city, heading = 0) {
  const rad = Math.PI / 180, latA = site.lat * rad, latB = city.lat * rad, dlon = (city.lon - site.lon) * rad;
  const bearing = Math.atan2(Math.sin(dlon) * Math.cos(latB), Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(dlon));
  const angle = bearing - heading;
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}
const directionArrow = (x, y) => ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][(Math.round(Math.atan2(x, -y) / (Math.PI / 4)) + 8) % 8];

/** Opening, scrubbing, and clicking this add-on never change the camera. */
export function attachElectricityMap(viewer, { eventTarget = window, fetchImpl = fetch, data = null, waterData = null } = {}) {
  const C = globalThis.Cesium, scene = viewer.scene, document = viewer.container.ownerDocument;
  const style = addStyle(document), root = document.createElement('div'), card = document.createElement('section'), details = document.createElement('button'), switcher = document.createElement('div');
  root.className = 'electricity-map-overlay'; root.hidden = true; root.setAttribute('aria-label', 'Nearest city utility prices');
  card.className = 'electricity-city-card'; card.hidden = true; root.appendChild(card); viewer.container.appendChild(root);
  switcher.className = 'city-cost-switch'; switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'City bill type');
  details.type = 'button'; details.className = 'electricity-city-details'; card.append(switcher, details);
  const kindButtons = {};
  for (const key of ['electricity', 'water']) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'city-cost-kind'; button.textContent = key === 'electricity' ? 'Electricity' : 'Water';
    button.setAttribute('aria-pressed', String(key === 'electricity')); button.onclick = () => setKind(key, true); switcher.appendChild(button); kindButtons[key] = button;
  }
  const fields = {};
  for (const name of ['name', 'bill', 'detail', 'meta']) { const child = document.createElement('span'); child.className = `electricity-city-${name}`; fields[name] = child; details.appendChild(child); }
  const disc = softDisc(document), occluder = new C.EllipsoidalOccluder(scene.globe.ellipsoid, viewer.camera.positionWC);
  let active = false, removed = false, site = eventTarget.CloudShadow?.state?.site ?? null;
  let year = Number(eventTarget.CloudShadowTimeline?.year || 2025), dataset = data, task = null, buildTask = null, generation = 0;
  let costKind = 'electricity', waterDataset = waterData, waterTask = null, waterFailed = false;
  let city = null, snapshot = null, entity = null, material = null, position = null, text = null;
  let current = [0, 0, 0, 0], from = [...current], to = [...current], animationStart = 0, animationEnd = 0, lastLayout = -Infinity, lastObstacleRead = -Infinity, cachedObstacles = [];
  const emit = (name, detail) => eventTarget.dispatchEvent(new CustomEvent(name, { detail }));
  const rgba = (v) => new C.Color(v[0] / 255, v[1] / 255, v[2] / 255, v[3] / 255);
  details.onclick = () => { if (city) emit('cs:electricity-city', { city, cityId: city.id, openDetails: true, kind: costKind }); };

  function clear() { if (entity) viewer.entities.remove(entity); entity = null; material = null; city = null; snapshot = null; position = null; card.hidden = true; }
  function notice(message) { text = null; fields.name.textContent = 'Nearby city bills'; fields.bill.textContent = message; fields.detail.textContent = 'Source-backed electricity and water rates'; fields.meta.textContent = 'No unsupported price estimate is shown.'; lastLayout = -Infinity; scene.requestRender?.(); }
  function build() {
    clear();
    if (!site || !dataset) return;
    city = nearestElectricityCity(dataset, site);
    if (!city) { notice('No nearby city record'); return; }
    position = C.Cartesian3.fromDegrees(city.lon, city.lat, 40); card.dataset.city = city.id;
    material = new C.ImageMaterialProperty({ image: disc, transparent: true, color: C.Color.TRANSPARENT });
    entity = viewer.entities.add({ id: `electricity-city-${city.id}`, name: `${city.name} electricity · ${city.state} state average`, position: C.Cartesian3.fromDegrees(city.lon, city.lat), show: false,
      ellipse: { semiMajorAxis: 4500, semiMinorAxis: 4500, material, height: 0, heightReference: C.HeightReference.CLAMP_TO_GROUND } });
    renderValues();
  }
  function renderValues() {
    if (!city || !dataset) return;
    const onset = dataset.sites?.[site?.id]?.onsetYear ?? Number(String(site?.onset).slice(0, 4));
    if (costKind === 'water') {
      snapshot = waterDataset ? waterPriceSnapshot(waterDataset, city, year, 3000) : { kind: 'unavailable', monthlyBillUsd: null };
      text = waterPriceCardText(city, snapshot, year);
      if (!waterDataset) text.bill = waterFailed ? 'Water rates unavailable' : 'Loading water rates…';
    } else { snapshot = electricitySnapshot(dataset, city, year, onset); text = electricityCardText(city, snapshot); }
    fields.name.textContent = text.title; fields.bill.textContent = text.bill; fields.detail.textContent = text.detail; fields.meta.textContent = text.provenance;
    details.title = `${text.title}. ${text.provenance}. Click for sources and the full comparison. ${costKind === 'water' ? 'Example at fixed water use; excludes sewer and is not an average household bill.' : 'Before/after is not a data-center-attributed cost.'}`;
    details.setAttribute('aria-label', `${text.title}. ${text.bill}. ${text.detail}. ${text.provenance}. Open ${costKind} details.`);
    from = [...current]; to = costKind === 'water' ? (snapshot.kind === 'unavailable' ? [0, 0, 0, 0] : [52, 140, 199, 90]) : electricityChangeColor(snapshot.changePct);
    animationStart = performance.now(); animationEnd = animationStart + TRANSITION_MS;
    entity.show = active && snapshot.kind !== 'unavailable' && (costKind === 'water' || finite(snapshot.changePct)); lastLayout = -Infinity; scene.requestRender?.();
  }
  function ensureWaterData() {
    if (waterDataset) return Promise.resolve(waterDataset);
    if (waterTask) return waterTask;
    waterFailed = false;
    waterTask = loadWaterPriceData({ fetchImpl }).then((value) => { if (!removed) { waterDataset = value; renderValues(); } return value; })
      .catch(() => { if (!removed) { waterFailed = true; renderValues(); } return null; }).finally(() => { waterTask = null; });
    return waterTask;
  }
  function setKind(value, announce = false) {
    if (!['electricity', 'water'].includes(value)) return;
    costKind = value;
    for (const [key, button] of Object.entries(kindButtons)) button.setAttribute('aria-pressed', String(key === value));
    if (value === 'water') ensureWaterData();
    renderValues();
    if (announce) emit('cs:city-cost-kind', { kind: value });
  }
  function ensureData() {
    if (buildTask) return buildTask;
    const id = ++generation;
    buildTask = Promise.resolve().then(async () => {
      try {
        dataset ??= await (task ??= loadElectricityData({ fetchImpl }));
        if (!dataset) throw new Error('Electricity dataset unavailable');
        if (!removed && id === generation) build();
      } catch (error) { task = null; if (!removed && id === generation) { clear(); notice('Records unavailable'); emit('cs:electricity-error', { message: error.message }); } }
      finally { buildTask = null; }
    }); return buildTask;
  }
  function setActive(value) {
    active = !!value; root.hidden = !active;
    if (entity) entity.show = active && snapshot?.kind !== 'unavailable' && (costKind === 'water' || finite(snapshot?.changePct));
    if (!active) card.hidden = true;
    else if (!city) { notice('Loading prices…'); ensureData(); } else renderValues();
    if (active && costKind === 'water') ensureWaterData();
    lastLayout = -Infinity; scene.requestRender?.();
  }
  function update(next = {}) {
    const changedSite = next.site && (next.site.id !== site?.id || next.site.lat !== site?.lat || next.site.lon !== site?.lon);
    if (next.data !== undefined) dataset = next.data;
    if (next.site) site = next.site;
    if (next.year != null && finite(Number(next.year))) year = Number(next.year);
    if (next.active !== undefined) { active = !!next.active; root.hidden = !active; }
    if (changedSite || next.data !== undefined) { if (dataset) build(); else if (active) ensureData(); }
    else renderValues();
    lastLayout = -Infinity;
  }
  function obstacles() {
    const canvas = scene.canvas.getBoundingClientRect(), out = [];
    for (const node of document.querySelectorAll('#v2Header,#v3Panel > .v3-body,#v3Panel > .v3-stat,#v3Panel > .v3-tabs,#v3Panel > .v3-ba,#v3Panel > .v3-links,#v3Pill,#timeline,#electricityPanel,#electricityDrawer')) {
      if (node.hidden || !node.getClientRects().length) continue;
      const r = node.getBoundingClientRect(); if (r.width && r.height) out.push({ x: r.left - canvas.left, y: r.top - canvas.top, w: r.width, h: r.height });
    } return out;
  }
  function layout(now) {
    const width = scene.canvas.clientWidth, height = scene.canvas.clientHeight, w = width < 680 ? 216 : 238, h = 164;
    if (now - lastObstacleRead >= 250) { cachedObstacles = obstacles(); lastObstacleRead = now; }
    const blocks = cachedObstacles;
    let point = null;
    if (city && position) {
      occluder.cameraPosition = viewer.camera.positionWC;
      const local = eventTarget.CloudShadowNeighborhood?.groundHeightAt?.(city.lon, city.lat), globe = scene.globe.getHeight?.(C.Cartographic.fromDegrees(city.lon, city.lat));
      position = C.Cartesian3.fromDegrees(city.lon, city.lat, (finite(local) ? local : finite(globe) ? globe : 0) + 40);
      if (occluder.isPointVisible(position)) point = C.SceneTransforms.worldToWindowCoordinates(scene, position);
    }
    const anchored = point && layoutElectricityCards([{ x: point.x, y: point.y, width: w, height: h }], { width, height, obstacles: blocks })[0];
    let box, direction;
    if (anchored) { box = { x: anchored.left, y: anchored.top }; card.dataset.locationMode = 'city'; if (text) fields.name.textContent = text.title; }
    else {
      direction = point && finite(point.x) && finite(point.y) ? { x: point.x - width / 2, y: point.y - height / 2 } : city && site ? electricityCityDirection(site, city, viewer.camera.heading || 0) : { x: 1, y: 0 };
      const length = Math.max(1e-9, Math.hypot(direction.x, direction.y));
      const px = Math.max(12, Math.min(width - w - 12, width / 2 + direction.x / length * (width / 2 - w / 2 - 20) - w / 2));
      const py = Math.max(82, Math.min(height - h - 12, height / 2 + direction.y / length * (height / 2 - h / 2 - 20) - h / 2));
      box = placeElectricityInfoBox({ width, height, boxWidth: w, boxHeight: h, obstacles: blocks, preferredX: px, preferredY: py });
      card.dataset.locationMode = 'edge';
      if (text) fields.name.textContent = `${directionArrow(direction.x, direction.y)} Toward ${text.title}`;
    }
    card.hidden = !box;
    if (box) { card.style.left = `${Math.round(box.x)}px`; card.style.top = `${Math.round(box.y)}px`; }
    root.dataset.visibleCards = box ? '1' : '0'; lastLayout = now;
  }
  const removePre = scene.preRender.addEventListener(() => {
    if (!active || removed || !animationEnd) return;
    const now = performance.now(); current = blendElectricityColor(from, to, (now - animationStart) / TRANSITION_MS);
    if (material) material.color = rgba(current);
    card.style.setProperty('--electricity-color', `rgb(${current.slice(0, 3).map(Math.round).join(',')})`);
    if (now >= animationEnd) animationEnd = 0; scene.requestRender?.();
  });
  // One projected card can follow the camera at 30 Hz. Reading primary UI
  // obstacle rectangles remains capped at 4 Hz to avoid repeated layout work.
  const removePost = scene.postRender.addEventListener(() => { if (active && !removed && performance.now() - lastLayout >= 32) layout(performance.now()); });
  const onSite = ({ detail }) => { if (detail?.site) update({ site: detail.site }); };
  const onYear = ({ detail }) => { if (!detail?.siteId || detail.siteId === site?.id) update({ year: detail?.year }); };
  const onElectricity = ({ detail = {} }) => { if (detail.site) update({ site: detail.site }); if (detail.active !== undefined) setActive(detail.active); };
  const onKind = ({ detail }) => { if (detail?.kind !== costKind) setKind(detail?.kind); };
  eventTarget.addEventListener('cs:site', onSite); eventTarget.addEventListener('cs:year', onYear); eventTarget.addEventListener('cs:electricity', onElectricity); eventTarget.addEventListener('cs:city-cost-kind', onKind);
  return { setActive, update,
    // Compatibility with earlier callers: this add-on has no overview flight.
    showCities: () => false, focusCity: () => false,
    get state() { return { active, kind: costKind, siteId: site?.id, year, cities: city ? [city.id] : [], visibleCards: Number(root.dataset.visibleCards || 0) }; },
    destroy() { if (removed) return; removed = true; generation++; eventTarget.removeEventListener('cs:site', onSite); eventTarget.removeEventListener('cs:year', onYear); eventTarget.removeEventListener('cs:electricity', onElectricity); eventTarget.removeEventListener('cs:city-cost-kind', onKind); removePre(); removePost(); clear(); root.remove(); style.remove(); },
  };
}
