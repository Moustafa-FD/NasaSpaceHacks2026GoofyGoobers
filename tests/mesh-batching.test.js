import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bakeMesh } from '../apps/web/js/mesh-batching.js';

function modelFixture() {
  const gltf = { accessors: [], bufferViews: [], materials: [
    { name: 'wall', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.75, 0.4] }, alphaMode: 'BLEND' },
    { name: 'roof', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1] }, doubleSided: true },
  ] }, chunks = []; let length = 0;
  const add = (values, width, componentType = 5126) => {
    if (length % 4) { const pad = new Uint8Array(4 - length % 4); chunks.push(pad); length += pad.length; }
    const arr = componentType === 5123 ? new Uint16Array(values) : componentType === 5125 ? new Uint32Array(values) : new Float32Array(values);
    const bytes = new Uint8Array(arr.buffer), view = gltf.bufferViews.length;
    gltf.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes); length += bytes.length;
    const index = gltf.accessors.length;
    gltf.accessors.push({ bufferView: view, componentType, type: { 1: 'SCALAR', 3: 'VEC3', 4: 'VEC4' }[width], count: values.length / width });
    return index;
  };
  const mesh = { name: 'two-flat-surfaces', extras: { authored: true }, primitives: [
    { attributes: { POSITION: add([0, 0, 0, 1, 0, 0, 0, 1, 0], 3), NORMAL: add([0, 0, 1, 0, 0, 1, 0, 0, 1], 3) }, indices: add([2, 0, 1], 1, 5123), material: 0 },
    { attributes: { POSITION: add([0, 0, 0, 0, 1, 0, 0, 0, 1], 3), NORMAL: add([1, 0, 0, 1, 0, 0, 1, 0, 0], 3) }, indices: add([0, 1, 2], 1, 5125), material: 1 },
  ] };
  // Nonzero outer offset exercises Buffer/Uint8Array views without assuming
  // the source ArrayBuffer begins where the GLB BIN payload begins.
  const outer = new Uint8Array(length + 13); let offset = 13;
  for (const chunk of chunks) { outer.set(chunk, offset); offset += chunk.length; }
  return { gltf, mesh, bin: outer.subarray(13) };
}

function collector(gltf) {
  const values = new Map();
  return { values, add(data, width, componentType = 5126) {
    const index = gltf.accessors.length;
    gltf.accessors.push({ componentType, type: { 1: 'SCALAR', 3: 'VEC3', 4: 'VEC4' }[width], count: data.length / width });
    values.set(index, [...data]); return index;
  } };
}

test('batching conserves triangle topology and flat normals across mixed u16/u32 primitives', () => {
  const { gltf, bin, mesh } = modelFixture(), output = collector(gltf);
  const merged = bakeMesh(gltf, bin, mesh, output.add);
  assert.equal(merged.name, mesh.name); assert.deepEqual(merged.extras, mesh.extras);
  assert.equal(merged.primitives.length, 1);
  assert.equal(mesh.primitives.length, 2, 'Original mesh is not mutated');
  const primitive = merged.primitives[0];
  assert.deepEqual(output.values.get(primitive.indices), [2, 0, 1, 3, 4, 5]);
  assert.deepEqual(output.values.get(primitive.attributes.POSITION), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(output.values.get(primitive.attributes.NORMAL), [0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0], 'Shared-position vertices retain distinct face normals');
  assert.equal(gltf.accessors[primitive.indices].componentType, 5125);
  assert.equal(gltf.accessors[primitive.attributes.COLOR_0].type, 'VEC4');
  assert.equal(gltf.accessors[primitive.attributes.COLOR_0].count, 6);
});

test('material palette colors are baked once into linear RGBA and white material preserves alpha/sidedness', () => {
  const { gltf, bin, mesh } = modelFixture(), output = collector(gltf);
  const merged = bakeMesh(gltf, bin, mesh, output.add), primitive = merged.primitives[0];
  const colors = output.values.get(primitive.attributes.COLOR_0);
  for (let vertex = 0; vertex < 6; vertex++) {
    const factor = vertex < 3 ? [0.5, 0.25, 0.75, 0.4] : [0.8, 0.6, 0.4, 1];
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(colors[vertex * 4 + c] - factor[c] ** 2.2) < 1e-12);
    assert.equal(colors[vertex * 4 + 3], factor[3]);
  }
  const material = gltf.materials[primitive.material];
  assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
  assert.equal(material.pbrMetallicRoughness.roughnessFactor, 0.9);
  assert.equal(material.pbrMetallicRoughness.metallicFactor, 0);
  assert.equal(material.alphaMode, 'BLEND'); assert.equal(material.doubleSided, true);
});

test('invalid source formats fail clearly instead of silently dropping geometry or attributes', () => {
  for (const [change, message] of [
    [(g, m) => { g.accessors[m.primitives[0].attributes.POSITION].componentType = 5123; }, /unsupported POSITION/],
    [(g, m) => { g.accessors[m.primitives[0].attributes.NORMAL].normalized = true; }, /unsupported NORMAL/],
    [(g, m) => { g.bufferViews[g.accessors[m.primitives[0].attributes.POSITION].bufferView].byteStride = 16; }, /interleaved POSITION/],
    [(g, m) => { g.accessors[m.primitives[0].attributes.NORMAL].count = 4; }, /NORMAL accessor exceeds/],
    [(g, m) => { m.primitives[0].attributes._VEGETATION = m.primitives[0].attributes.POSITION; }, /add scene attributes after baking/],
    [(g, m) => { m.primitives[0].mode = 1; }, /static triangle/],
    [(g) => { g.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }; }, /textured source/],
  ]) {
    const { gltf, bin, mesh } = modelFixture(); change(gltf, mesh);
    const output = collector(gltf);
    assert.throws(() => bakeMesh(gltf, bin, mesh, output.add), message);
    assert.equal(output.values.size, 0, 'Invalid input is rejected before appending accessors');
  }
  const { gltf, bin, mesh } = modelFixture(), output = collector(gltf);
  assert.throws(() => bakeMesh(gltf, bin.subarray(0, bin.length - 1), mesh, output.add), /source buffer/);
});

test('indices that address a different primitive are rejected', () => {
  const { gltf, bin, mesh } = modelFixture(), output = collector(gltf);
  const accessor = gltf.accessors[mesh.primitives[0].indices], view = gltf.bufferViews[accessor.bufferView];
  new DataView(bin.buffer, bin.byteOffset).setUint16(view.byteOffset, 9, true);
  assert.throws(() => bakeMesh(gltf, bin, mesh, output.add), /source index exceeds/);
});

test('every authored kit mesh batches into one primitive without changing its vertex or triangle count', () => {
  const blob = readFileSync(new URL('../apps/web/assets/low-poly/kit.glb', import.meta.url));
  const jsonLength = blob.readUInt32LE(12), gltf = JSON.parse(blob.subarray(20, 20 + jsonLength));
  const binLength = blob.readUInt32LE(20 + jsonLength), bin = blob.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  const output = collector(gltf);
  assert.ok(gltf.meshes.length >= 65);
  for (const mesh of gltf.meshes) {
    const oldTriangles = mesh.primitives.reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0);
    const oldVertices = mesh.primitives.reduce((n, p) => n + gltf.accessors[p.attributes.POSITION].count, 0);
    const merged = bakeMesh(gltf, bin, mesh, output.add), primitive = merged.primitives[0];
    assert.equal(merged.primitives.length, 1);
    assert.equal(gltf.accessors[primitive.indices].count / 3, oldTriangles, mesh.name);
    assert.equal(gltf.accessors[primitive.attributes.POSITION].count, oldVertices, mesh.name);
    assert.equal(gltf.accessors[primitive.attributes.NORMAL].count, oldVertices, mesh.name);
    assert.equal(gltf.accessors[primitive.attributes.COLOR_0].count, oldVertices, mesh.name);
    assert.ok(output.values.get(primitive.indices).every((i) => i >= 0 && i < oldVertices));
    assert.ok(output.values.get(primitive.attributes.COLOR_0).every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  }
});
