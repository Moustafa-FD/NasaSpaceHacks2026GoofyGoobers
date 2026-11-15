import test from 'node:test';
import assert from 'node:assert/strict';

test('electricity suspends and restores actual theme visuals without breaking the scene cache', async (t) => {
  const previous = Object.fromEntries(['window', 'document', 'location', 'Cesium'].map(key => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });

  const entities = new Set();
  let added = 0, removed = 0;
  const viewer = { entities: {
    add(spec) { added++; entities.add(spec); return spec; },
    remove(spec) { if (entities.delete(spec)) removed++; },
  } };
  globalThis.window = new EventTarget();
  window.CloudShadow = { viewer };
  globalThis.location = { search: '' };
  globalThis.document = {
    body: { classList: { contains: () => false } },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return { width: 0, height: 0, getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
      }) };
    },
  };
  globalThis.Cesium = {
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    CallbackProperty: class { constructor(callback) { this.getValue = callback; } },
    ImageMaterialProperty: class { constructor(options) { Object.assign(this, options); } },
    Color: class { constructor(red, green, blue, alpha) { Object.assign(this, { red, green, blue, alpha }); } },
  };

  // Import the real browser module and exercise its public event boundary.
  await import('../apps/web/js/theme-visuals.js?electricity-theme-integration');
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  const site = { id: 'site', lat: 35, lon: -90, onset: '2024-06', effects: {} };
  const facts = { years: { rowVar: 'LST_Night' } };
  const theme = { theme: 'heat', site, facts, year: 2025, mapOn: false };
  emit('cs:theme', theme);
  assert.equal(entities.size, 4, 'heat glow and three ripples are built');
  const originalEntities = [...entities], initialAdds = added;
  emit('cs:theme', theme);
  assert.equal(added, initialAdds, 'repeating the same cached theme does not rebuild entities');
  assert.deepEqual([...entities], originalEntities);

  emit('cs:electricity', { active: true });
  assert.equal(entities.size, 0, 'electricity clears the heat theme even though site and year did not change');
  assert.equal(removed, initialAdds);
  emit('cs:year', { siteId: site.id, year: 2026, row: { LST_Night_Local: .5 } });
  emit('cs:theme', { ...theme, year: 2026 });
  assert.equal(entities.size, 0, 'timeline and theme events cannot restore environmental visuals while electricity is active');
  assert.equal(added, initialAdds);

  emit('cs:electricity', { active: false });
  assert.equal(entities.size, 4, 'closing electricity restores the selected environmental theme');
  const restoredEntities = [...entities], restoredAdds = added;
  const radius = restoredEntities[0].ellipse.semiMajorAxis;
  assert.equal(radius.getValue(), 6500, 'restored visuals use the latest year values');
  emit('cs:theme', { ...theme, year: 2026 });
  emit('cs:year', { siteId: site.id, year: 2026, row: { LST_Night_Local: .5 } });
  assert.equal(added, restoredAdds, 'same theme and year keep the restored scene cache');
  assert.deepEqual([...entities], restoredEntities);

  emit('cs:year', { siteId: site.id, year: 2027, row: { LST_Night_Local: .1 } });
  assert.equal(added, restoredAdds, 'ordinary year changes update callbacks without rebuilding the scene');
  assert.equal(radius.getValue(), 2900, 'cached callbacks still read changing yearly measurements');
});
