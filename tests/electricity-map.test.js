import test from 'node:test';
import assert from 'node:assert/strict';
import { attachElectricityMap, electricityChangeColor, blendElectricityColor, layoutElectricityCards, placeElectricityInfoBox, electricityCardText, waterPriceCardText, ELECTRICITY_CITY_LIMIT } from '../apps/web/js/electricity-map.js';

test('city price symbols use one signed scale, and unknown increases remain transparent', () => {
  assert.deepEqual(electricityChangeColor(null), [0, 0, 0, 0]);
  assert.deepEqual(electricityChangeColor(NaN), [0, 0, 0, 0]);
  const down = electricityChangeColor(-20), flat = electricityChangeColor(0), up = electricityChangeColor(20);
  assert(down[2] > down[0], 'a price fall is blue');
  assert(up[0] > up[2], 'a price rise is warm');
  assert(up[3] > flat[3]);
  assert.deepEqual(electricityChangeColor(500), electricityChangeColor(50), 'fixed +50% endpoint never rescales with the visible cities');
  assert.deepEqual(electricityChangeColor(-500), electricityChangeColor(-50));
});

test('smooth price colour transitions reach both endpoints and are bounded', () => {
  const before = electricityChangeColor(-10), after = electricityChangeColor(30);
  assert.deepEqual(blendElectricityColor(before, after, -1), before);
  assert.deepEqual(blendElectricityColor(before, after, 2), after);
  const middle = blendElectricityColor(before, after, .5);
  for (let i = 0; i < 4; i++) assert.equal(middle[i], (before[i] + after[i]) / 2);
});

test('camera-facing city cards avoid controls, each other, the horizon margins and viewport edges', () => {
  const input = [
    { id: 'covered', x: 190, y: 230 },
    { id: 'visible', x: 500, y: 250 },
    { id: 'overlap', x: 505, y: 255 },
    { id: 'offscreen', x: 20, y: 250 },
    { id: 'horizon', x: 700, y: 100 },
    { id: 'second', x: 800, y: 450 },
  ];
  const result = layoutElectricityCards(input, { width: 1000, height: 600, obstacles: [{ x: 0, y: 0, w: 300, h: 500 }] });
  assert.deepEqual(result.map((r) => r.id), ['visible']);
  assert(result.length <= ELECTRICITY_CITY_LIMIT);
  assert.equal(layoutElectricityCards(input, { width: 1000, height: 600, maxCards: 1 }).length, 1);
});

test('the single offscreen city card fits around the unchanged main UI', () => {
  const controls = [
    { x: 16, y: 76, w: 436, h: 260 }, // original claim panel
    { x: 16, y: 360, w: 75, h: 310 }, // original theme rail
    { x: 1170, y: 77, w: 382, h: 610 }, // added cost panel
    { x: 550, y: 760, w: 680, h: 120 }, // original before/after
    { x: 620, y: 710, w: 300, h: 38 }, // original statistic
  ];
  const box = placeElectricityInfoBox({ width: 1600, height: 900, boxWidth: 238, boxHeight: 123, obstacles: controls });
  assert(box, 'a free lower-left gap is used');
  assert.equal(box.x, 110);
  assert(box.y > 670);
  for (const c of controls) {
    assert(!(box.x < c.x + c.w && box.x + box.w > c.x && box.y < c.y + c.h && box.y + box.h > c.y), 'original controls remain unobscured');
  }
  assert.equal(placeElectricityInfoBox({ width: 390, height: 700, boxWidth: 280, boxHeight: 150, obstacles: [{ x: 0, y: 0, w: 390, h: 700 }] }), null, 'no space means hide only the supplemental annotation');
});

test('city cards retain reference year, price units, geography and forecast labels', () => {
  const city = { name: 'Memphis', state: 'TN' };
  const snapshot = { year: 2030, kind: 'projected', priceCentsKwh: 14.42, monthlyBillUsd: 154, changePct: 13.2, baselineYear: 2023, baselineBillUsd: 135 };
  const text = electricityCardText(city, snapshot);
  assert.equal(text.title, 'Memphis · TN');
  assert.equal(text.bill, '$154/mo · 2030');
  assert.match(text.comparison, /\+13\.2% price/);
  assert.match(text.before, /2023: \$135\/mo/);
  assert.match(text.detail, /2023: \$135\/mo · \+13\.2% price/);
  assert.equal(text.provenance, '14.42¢/kWh · estimate · state avg');
  const missing = electricityCardText(city, { ...snapshot, year: 2080, kind: 'unavailable', priceCentsKwh: null, monthlyBillUsd: null, changePct: null });
  assert.equal(missing.bill, 'No price for 2080');
  assert.equal(missing.provenance, 'No estimate · unavailable · state avg');
  assert.doesNotMatch(missing.bill, /\$0/);
});

test('water example bills retain cents, source date uncertainty, fixed usage and reference labels', () => {
  const city = { name: 'Horn Lake', state: 'MS' };
  const text = waterPriceCardText(city, { kind: 'reference', monthlyBillUsd: 14.44, monthlyGallons: 3000, rateYear: 2024 }, 2035);
  assert.equal(text.bill, '$14.44/mo*');
  assert.match(text.detail, /3,000 gal\/month example · water only/);
  assert.equal(text.provenance, 'Published 2024 rate · reference, not a 2035 forecast');
  const undated = waterPriceCardText(city, { kind: 'reference', monthlyBillUsd: 15.91, monthlyGallons: 3000, rateYear: null }, 2035);
  assert.equal(undated.bill, '$15.91/mo*');
  assert.equal(undated.provenance, 'Published rate · date unspecified · reference only');
  const missing = waterPriceCardText(city, { kind: 'unavailable', monthlyBillUsd: null, monthlyGallons: 3000 }, 2035);
  assert.equal(missing.bill, 'No published water price');
  assert.doesNotMatch(missing.bill, /\$0/);
});

function sceneFixture() {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {} }; this.nodes = new Map(); }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); return node; }
    remove() {}
    setAttribute() {}
    querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
    getContext() { return { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }; }
  }
  const document = { createElement: (tag) => { const node = new Element(); node.tagName = tag.toUpperCase(); return node; }, head: new Element(), querySelectorAll: () => [], querySelector: () => null };
  const listeners = [], entities = [], flights = [];
  const event = { addEventListener(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } };
  const container = new Element(); container.ownerDocument = document;
  const viewer = { container, scene: { globe: { ellipsoid: {} }, preRender: event, postRender: event, requestRender() {} }, camera: { positionWC: {}, flyToBoundingSphere: (...args) => flights.push(args) },
    entities: { add(spec) { entities.push(spec); return spec; }, remove(spec) { entities.splice(entities.indexOf(spec), 1); } } };
  const cesium = {
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    EllipsoidalOccluder: class {}, ImageMaterialProperty: class { constructor(options) { Object.assign(this, options); } },
    Color: Object.assign(class {}, { TRANSPARENT: {} }), HeightReference: { CLAMP_TO_GROUND: 1 },
    BoundingSphere: { fromPoints: (points) => ({ points, radius: 10000 }) }, HeadingPitchRange: class { constructor(heading, pitch, range) { Object.assign(this, { heading, pitch, range }); } },
  };
  const site = { id: 'study', lat: 35, lon: -90, onset: '2024-01' }, target = new EventTarget();
  target.CloudShadow = { state: { site } }; target.CloudShadowTimeline = { year: 2024 };
  const data = { schemaVersion: 1, states: { TN: { name: 'Tennessee', records: [{ year: 2023, priceCentsKwh: 12, monthlyBillUsd: 120, monthlyKwh: 1000 }, { year: 2024, priceCentsKwh: 13, monthlyBillUsd: 130, monthlyKwh: 1000 }] } },
    cities: [{ id: 'city', name: 'Example city', state: 'TN', lat: 35.1, lon: -90 }], sites: { study: { cityIds: ['city'], onsetYear: 2024 } } };
  return { viewer, target, data, cesium, entities, flights, listeners };
}

test('one nearest-city card opens details without moving the camera on activation, years or click', async () => {
  const f = sceneFixture(), previous = globalThis.Cesium; globalThis.Cesium = f.cesium;
  let map;
  try {
    f.data.cities.push({ id: 'closer', name: 'Closest city', state: 'TN', lat: 35.005, lon: -90 });
    f.data.sites.study.cityIds.push('closer');
    map = attachElectricityMap(f.viewer, { eventTarget: f.target, data: f.data });
    f.target.dispatchEvent(new CustomEvent('cs:electricity', { detail: { active: true, fly: true, cityId: 'city' } }));
    await new Promise(setImmediate);
    assert.equal(f.entities.length, 1);
    assert.equal(f.entities[0].ellipse.heightReference, f.cesium.HeightReference.CLAMP_TO_GROUND);
    assert.equal(f.entities[0].position.lat, 35.005, 'the closest city is used rather than the requested far city');
    assert.deepEqual(map.state.cities, ['closer']);
    const overlay = f.viewer.container.children[0], card = overlay.children[0];
    assert.equal(overlay.children.length, 1, 'no extra legend or fallback dialog exists');
    let detail;
    f.target.addEventListener('cs:electricity-city', (event) => { detail = event.detail; });
    f.target.dispatchEvent(new CustomEvent('cs:year', { detail: { siteId: 'study', year: 2023 } }));
    card.children[1].onclick();
    assert.equal(detail.cityId, 'closer'); assert.equal(detail.openDetails, true);
    assert.equal(detail.kind, 'electricity');
    map.showCities(); map.focusCity();
    assert.equal(f.flights.length, 0);
    assert.equal(map.state.active, true);
  } finally {
    map?.destroy(); globalThis.Cesium = previous;
  }
  assert.equal(f.entities.length, 0);
  assert.equal(f.listeners.length, 0);
});

test('the same single card switches to water without nested buttons, side effects or blocking electricity on failure', async () => {
  const f = sceneFixture(), previous = globalThis.Cesium; globalThis.Cesium = f.cesium;
  let map;
  try {
    map = attachElectricityMap(f.viewer, { eventTarget: f.target, data: f.data, fetchImpl: async () => { throw new Error('water unavailable'); } });
    map.setActive(true); await new Promise(setImmediate);
    const overlay = f.viewer.container.children[0], card = overlay.children[0], switcher = card.children[0], details = card.children[1];
    assert.equal(card.tagName, 'SECTION'); assert.equal(switcher.tagName, 'DIV'); assert.equal(details.tagName, 'BUTTON');
    assert(switcher.children.every((button) => button.tagName === 'BUTTON'));
    assert(details.children.every((field) => field.tagName === 'SPAN'), 'detail button contains text only');
    let kindEvent, detail;
    f.target.addEventListener('cs:city-cost-kind', (event) => { kindEvent = event.detail; });
    f.target.addEventListener('cs:electricity-city', (event) => { detail = event.detail; });
    switcher.children[1].onclick(); await new Promise(setImmediate);
    assert.equal(kindEvent.kind, 'water'); assert.equal(map.state.kind, 'water');
    details.onclick(); assert.equal(detail.kind, 'water'); assert.equal(detail.openDetails, true);
    assert.equal(details.children[1].textContent, 'Water rates unavailable');
    switcher.children[0].onclick();
    assert.equal(map.state.kind, 'electricity'); assert.match(details.children[1].textContent, /\$130\/mo/);
    assert.equal(overlay.children.length, 1); assert.equal(f.entities.length, 1); assert.equal(f.flights.length, 0);
  } finally { map?.destroy(); globalThis.Cesium = previous; }
});

test('an electricity data reply cannot move the camera after the user closes the view', async () => {
  const f = sceneFixture(), previous = globalThis.Cesium; globalThis.Cesium = f.cesium;
  let resolve, map;
  try {
    const reply = new Promise((done) => { resolve = done; });
    map = attachElectricityMap(f.viewer, { eventTarget: f.target, fetchImpl: () => reply });
    map.setActive(true);
    map.setActive(false);
    resolve({ ok: true, json: async () => f.data });
    await new Promise(setImmediate);
    assert.equal(f.flights.length, 0);
    assert.equal(map.state.active, false);
  } finally { map?.destroy(); globalThis.Cesium = previous; }
});

test('closing and reopening retries a failed electricity acquisition without duplicate cards or camera movement', async () => {
  const f = sceneFixture(), previous = globalThis.Cesium; globalThis.Cesium = f.cesium;
  let calls = 0, map;
  try {
    map = attachElectricityMap(f.viewer, { eventTarget: f.target, fetchImpl: async () => {
      if (++calls === 1) throw new Error('temporary failure');
      return { ok: true, json: async () => f.data };
    } });
    map.setActive(true); await new Promise(setImmediate);
    assert.equal(f.entities.length, 0);
    map.setActive(false); map.setActive(true); await new Promise(setImmediate);
    assert.equal(calls, 2); assert.equal(f.entities.length, 1);
    assert.deepEqual(map.state.cities, ['city']); assert.equal(f.viewer.container.children[0].children.length, 1);
    assert.equal(f.flights.length, 0);
  } finally { map?.destroy(); globalThis.Cesium = previous; }
});
