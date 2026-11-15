// Projected map years (2027-2035): latest real same-season pixel + that pixel's own
// significant NASA trend. Pixels without a significant trend never change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { decodeTrendMap, tileProjection, recolorEvidence, MAP_SCALES } from '../apps/web/js/evidence-map.js';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const encode = (values, scale) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(Math.round(v / scale), i * 2)); return b.toString('base64'); };
const tiny = (slopes, extra = {}) => ({ schemaVersion: 'trend-map/1.0', z: 9, gx0: 512, gy0: 768, width: 2, height: 2, slopeScale: 1e-4, slope: encode(slopes, 1e-4), ...extra });

test('decoder restores per-pixel slopes and rejects malformed products', () => {
  const t = decodeTrendMap(tiny([0.01, 0, -0.02, 0.005]));
  assert.deepEqual([...t.slope].map((v) => +v.toFixed(4)), [0.01, 0, -0.02, 0.005]);
  assert.throws(() => decodeTrendMap({ ...tiny([0, 0, 0, 0]), width: 3 }), /mismatch/);
  assert.throws(() => decodeTrendMap({ schemaVersion: 'x' }), /Unsupported/);
});

test('tile pixels map onto the native grid at native and coarser zoom levels', () => {
  const trend = decodeTrendMap(tiny([0.01, 0, -0.02, 0.005]));
  const native = tileProjection({ trend, years: 4 }, 2, 3, 9); // tile (2,3) starts at gx 512, gy 768
  assert.equal(+native(0).toFixed(4), 0.04);            // gx 512, gy 768
  assert.equal(native(1), 0);                            // not significant -> unchanged
  assert.equal(+native(256).toFixed(4), -0.08);          // next row
  assert.equal(native(5), 0, 'outside the grid stays unchanged');
  assert.equal(tileProjection({ trend, years: 4 }, 0, 0, 9), null, 'tiles away from the site are untouched');
  assert.equal(tileProjection({ trend, years: 0 }, 2, 3, 9), null, 'no projection for the base year');
  const coarse = tileProjection({ trend, years: 1 }, 1, 1, 8); // z8 tile (1,1) covers native gx 512.., gy 512..
  assert.equal(typeof coarse, 'function');
});

test('recolouring adds the projected change and keeps values on the colour scale', () => {
  const lut = new Map([[0x010203, 0.5], [0x040506, 0.9], [0x070809, 0.1]]);
  const pixels = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
  const plain = recolorEvidence(pixels, null, lut, { scale: MAP_SCALES.NDVI, vegetation: true });
  const same = recolorEvidence(pixels, null, lut, { scale: MAP_SCALES.NDVI, vegetation: true, adjust: () => 0 });
  assert.deepEqual([...same], [...plain], 'zero trend leaves the latest real map unchanged');
  const browner = recolorEvidence(pixels, null, lut, { scale: MAP_SCALES.NDVI, vegetation: true, adjust: (i) => (i === 0 ? -0.3 : 5) });
  assert.notDeepEqual([...browner.slice(0, 4)], [...plain.slice(0, 4)]);
  assert.deepEqual([...browner.slice(4, 8)], [...plain.slice(4, 8)], 'clamped to the colormap maximum (0.9)');
});

test('committed trend maps exist for every site and map variable, with honest statistics', () => {
  const index = json('../data/cloudshadow/trendmaps/index.json');
  const sites = json('../data/cloudshadow/sites.json').sites.map((s) => s.id);
  assert.equal(index.projectionThrough, 2035);
  for (const site of sites) for (const variable of ['NDVI', 'LST_Day', 'LST_Night', 'AOD', 'NO2_OMI']) {
    assert.ok(index.sites[site]?.includes(variable), `${site} ${variable}`);
    const raw = json(`../data/cloudshadow/trendmaps/${site}/${variable}.json`);
    const t = decodeTrendMap(raw);
    assert.equal(t.slope.length, raw.width * raw.height);
    assert.equal(raw.method.multipleTesting, 'Benjamini-Hochberg across pixels');
    assert.ok(raw.stats.significant <= raw.stats.tested);
    assert.equal(t.slope.filter((v) => v !== 0).length, raw.stats.significant, 'only significant pixels carry a slope');
    assert.match(raw.evidence, /not a forecast/);
  }
});

test('Colossus 1 greenness: facility pixels lose green while the region mostly gains', () => {
  const raw = json('../data/cloudshadow/trendmaps/colossus1/NDVI.json');
  assert.ok(raw.stats.negativeShare < 0.5);
  const t = decodeTrendMap(raw), lat = 35.0601, lon = -90.1564, n = 256 * 2 ** t.z;
  const gx = Math.floor((lon + 180) / 360 * n) - t.gx0, s = Math.sin(lat * Math.PI / 180);
  const gy = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n) - t.gy0;
  const near = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) near.push(t.slope[(gy + dy) * t.width + gx + dx]);
  assert.ok(near.filter((v) => v < 0).length >= 5, 'several facility pixels have a significant browning trend');
});

test('the app projects map years after the record through 2035 only, and labels them', () => {
  const app = readFileSync(new URL('../apps/web/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /TREND_MAP_LAST_YEAR = 2035/);
  assert.match(app, /PROJECTED \$\{year\}/);
  assert.match(app, /not a forecast/);
  assert.ok(existsSync(new URL('../scripts/trend_maps.py', import.meta.url)));
});
