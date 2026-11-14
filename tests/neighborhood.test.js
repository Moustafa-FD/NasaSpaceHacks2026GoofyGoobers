import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  planNeighborhood, buildNeighborhoodGlb, readGlb, contains, segmentDistance,
  heightFor, orientedBox,
} from '../apps/web/js/neighborhood-core.js';

const manifest = JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json', import.meta.url)));
const kit = readFileSync(new URL('../apps/web/assets/low-poly/kit.glb', import.meta.url));
const modelById = new Map(manifest.models.map((m) => [m.id, m]));
const rectangle = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function rotatedRectangle(x, y, width, depth, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return rectangle(-width / 2, -depth / 2, width / 2, depth / 2)
    .map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

function fixture(overrides = {}) {
  return {
    schemaVersion: 1, siteId: 'test-village', center: { lat: 35, lon: -90 }, radiusM: 260,
    source: { name: 'OpenStreetMap fixture', license: 'ODbL-1.0' },
    buildings: [
      { id: 'way/home-east', polygon: rotatedRectangle(70, 65, 12, 22, Math.PI / 6), tags: { building: 'house', height: '30 ft' } },
      { id: 'way/shop-west', polygon: rectangle(-95, 52, -71, 69), tags: { building: 'retail', 'building:levels': '2' } },
      { id: 'way/apartments', polygon: rectangle(80, -100, 110, -80), tags: { building: 'apartments', height: '15' } },
      { id: 'way/warehouse', polygon: rectangle(-110, -115, -65, -60), tags: { building: 'warehouse' } },
    ],
    roads: [{ id: 'way/main-street', kind: 'residential', width: 6, points: [[-180, 0], [180, 0]] }],
    areas: [
      { id: 'land/residential', kind: 'residential', polygon: rectangle(-190, -150, 190, 145), holes: [rectangle(115, 10, 155, 55)] },
      { id: 'land/forest', kind: 'forest', polygon: rectangle(-220, 155, 220, 220) },
      { id: 'water/lake', kind: 'water', polygon: rectangle(20, 145, 100, 215), holes: [rectangle(50, 165, 65, 180)] },
    ],
    trees: [{ id: 'node/known-tree', x: -150, y: 100 }], waterways: [],
    ...overrides,
  };
}

function footprintSamples(instance, subdivisions = 4) {
  const model = modelById.get(instance.model);
  assert.ok(model, `Unknown model ${instance.model}`);
  const width = model.width * instance.scale[0], depth = model.depth * instance.scale[2];
  const c = Math.cos(instance.angle), s = Math.sin(instance.angle), points = [];
  for (let i = 0; i <= subdivisions; i++) for (let j = 0; j <= subdivisions; j++) {
    const u = (i / subdivisions - 0.5) * width, v = (j / subdivisions - 0.5) * depth;
    points.push([instance.x + u * c - v * s, instance.y + u * s + v * c]);
  }
  return points;
}

function assertInfillPlacement(data, plan) {
  const residential = data.areas.filter((a) => a.kind === 'residential');
  const water = data.areas.filter((a) => a.kind === 'water');
  for (const instance of plan.instances.filter((i) => i.source === 'illustrative-infill')) {
    for (const point of footprintSamples(instance)) {
      assert.ok(residential.some((a) => contains(point, a.polygon, a.holes)), `${instance.id} extends outside a residential parcel or into its hole at ${point}`);
      assert.ok(!water.some((a) => contains(point, a.polygon, a.holes)), `${instance.id} extends into mapped water at ${point}`);
      for (const segment of plan.roads) {
        assert.ok(segmentDistance(point, segment.a, segment.b) >= segment.width / 2 - 0.01,
          `${instance.id} extends into mapped road ${segment.id} at ${point}`);
      }
    }
  }
}

function assertCropPlacement(data, plan) {
  const farmland = data.areas.filter((a) => a.kind === 'farmland');
  const water = data.areas.filter((a) => a.kind === 'water');
  for (const instance of plan.instances.filter((i) => i.kind === 'crop')) {
    assert.equal(instance.source, 'illustrative-crop', 'Crop art must remain identified as illustrative');
    for (const point of footprintSamples(instance)) {
      assert.ok(farmland.some((a) => contains(point, a.polygon, a.holes)), `${instance.id} extends outside mapped farmland or into its hole at ${point}`);
      assert.ok(!water.some((a) => contains(point, a.polygon, a.holes)), `${instance.id} extends into mapped water at ${point}`);
      for (const road of plan.roads) assert.ok(segmentDistance(point, road.a, road.b) >= road.width / 2 - 0.01, `${instance.id} extends into road ${road.id} at ${point}`);
    }
  }
}

const componentReaders = {
  5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'],
  5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'],
};
const dimensions = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function verifyGlb(buffer) {
  const bytes = new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(header.getUint32(0, true), 0x46546c67, 'GLB magic');
  assert.equal(header.getUint32(4, true), 2, 'GLB version');
  assert.equal(header.getUint32(8, true), bytes.byteLength, 'Header length covers the entire file');
  const chunks = [];
  for (let p = 12; p < bytes.byteLength;) {
    assert.ok(p + 8 <= bytes.byteLength);
    const length = header.getUint32(p, true), kind = header.getUint32(p + 4, true);
    assert.equal(length % 4, 0, 'Chunks must be 4-byte aligned');
    assert.ok(p + 8 + length <= bytes.byteLength, 'Chunk extends past file');
    chunks.push({ kind, bytes: bytes.subarray(p + 8, p + 8 + length) });
    p += length + 8;
  }
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].kind, 0x4e4f534a);
  assert.equal(chunks[1].kind, 0x004e4942);
  const gltf = JSON.parse(new TextDecoder().decode(chunks[0].bytes));
  const binary = chunks[1].bytes;
  assert.equal(gltf.buffers.length, 1);
  assert.equal(gltf.buffers[0].byteLength, binary.byteLength);
  for (const view of gltf.bufferViews) {
    assert.equal(view.buffer, 0);
    assert.equal((view.byteOffset || 0) % 4, 0);
    assert.ok(view.byteLength > 0);
    assert.ok((view.byteOffset || 0) + view.byteLength <= binary.byteLength, 'Buffer view extends beyond BIN chunk');
  }
  const values = gltf.accessors.map((accessor) => {
    const view = gltf.bufferViews[accessor.bufferView];
    assert.ok(view, 'Accessor references an existing buffer view');
    const [componentSize, reader] = componentReaders[accessor.componentType] || [];
    const width = dimensions[accessor.type];
    assert.ok(componentSize && width, 'Supported component and accessor type');
    assert.ok(Number.isInteger(accessor.count) && accessor.count > 0, 'Accessor count must be a positive integer');
    const start = (view.byteOffset || 0) + (accessor.byteOffset || 0), stride = view.byteStride || width * componentSize;
    assert.equal(start % componentSize, 0);
    assert.ok((accessor.byteOffset || 0) + (accessor.count - 1) * stride + width * componentSize <= view.byteLength);
    const input = new DataView(binary.buffer, binary.byteOffset, binary.byteLength), decoded = [];
    const minima = Array(width).fill(Infinity), maxima = Array(width).fill(-Infinity);
    for (let i = 0; i < accessor.count; i++) for (let j = 0; j < width; j++) {
      const value = input[reader](start + i * stride + j * componentSize, true);
      assert.ok(Number.isFinite(value), 'All accessor values must be finite');
      decoded.push(value); minima[j] = Math.min(minima[j], value); maxima[j] = Math.max(maxima[j], value);
    }
    if (accessor.min) for (let j = 0; j < width; j++) {
      assert.ok(Math.abs(accessor.min[j] - minima[j]) <= 1e-5 * Math.max(1, Math.abs(minima[j])), 'Accessor min matches actual binary data');
      assert.ok(Math.abs(accessor.max[j] - maxima[j]) <= 1e-5 * Math.max(1, Math.abs(maxima[j])), 'Accessor max matches actual binary data');
    }
    return decoded;
  });
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    const position = gltf.accessors[primitive.attributes.POSITION], indices = values[primitive.indices];
    assert.ok(position);
    assert.ok(gltf.materials[primitive.material]);
    assert.equal(position.type, 'VEC3');
    assert.equal(gltf.accessors[primitive.attributes.NORMAL].count, position.count);
    for (const [name, index] of Object.entries(primitive.attributes)) assert.equal(gltf.accessors[index].count, position.count, `${name} count must match POSITION`);
    assert.equal(indices.length % 3, 0);
    for (const index of indices) assert.ok(Number.isInteger(index) && index >= 0 && index < position.count);
  }
  assert.ok(gltf.scenes[gltf.scene || 0]);
  for (const index of gltf.scenes[gltf.scene || 0].nodes) assert.ok(gltf.nodes[index]);
  for (const node of gltf.nodes) if (node.mesh !== undefined) assert.ok(gltf.meshes[node.mesh]);
  return { gltf, values, binary };
}

test('identical source snapshots produce identical geometry choices, colors and transforms', () => {
  const data = fixture(), options = { maxBuildings: 100, maxTrees: 100 };
  const first = planNeighborhood(data, manifest, options), second = planNeighborhood(structuredClone(data), manifest, options);
  assert.deepEqual(first.instances, second.instances);
  assert.deepEqual(first.stats, second.stats);
  assert.deepEqual(first.focus, second.focus);
  const reversed = planNeighborhood({ ...data, buildings: [...data.buildings].reverse() }, manifest, options);
  const mapped = (plan) => plan.instances.filter((i) => i.source === 'mapped');
  assert.deepEqual(mapped(first), mapped(reversed), 'Source ordering cannot recolor or relocate mapped buildings');
});

test('source IDs provide stable model and color variation without requiring every pair to differ', () => {
  const buildings = Array.from({ length: 40 }, (_, n) => ({
    id: `way/stable-home-${n}`, tags: { building: 'house' },
    polygon: rectangle((n % 8) * 30 - 120, Math.floor(n / 8) * 30 - 60, (n % 8) * 30 - 108, Math.floor(n / 8) * 30 - 42),
  }));
  const data = fixture({ buildings, roads: [], areas: [], trees: [] });
  const first = planNeighborhood(data, manifest, { maxTrees: 0 });
  const second = planNeighborhood(data, manifest, { maxTrees: 0 });
  assert.deepEqual(first.instances, second.instances);
  assert.ok(new Set(first.instances.map((i) => i.palette)).size >= 3);
  assert.ok(new Set(first.instances.map((i) => i.model)).size >= 3);
  assert.equal(new Set(first.instances.map((i) => i.id)).size, buildings.length);
});

test('mapped footprints retain their center, orientation and feet-based height', () => {
  const angle = Math.PI / 6, polygon = rotatedRectangle(70, 65, 12, 22, angle);
  const data = fixture({ buildings: [{ id: 'way/angled-house', polygon, tags: { building: 'house', height: '30 ft' } }], roads: [], areas: [], trees: [] });
  const plan = planNeighborhood(data, manifest, { maxTrees: 0 }), instance = plan.instances[0], model = modelById.get(instance.model);
  assert.equal(instance.source, 'mapped');
  assert.ok(Math.abs(instance.x - 70) < 1e-8 && Math.abs(instance.y - 65) < 1e-8);
  assert.ok(Math.abs(model.height * instance.scale[1] - 9.144) < 1e-8);
  assert.equal(plan.stats.mappedHeights, 1);
  for (const point of footprintSamples(instance)) assert.ok(contains(point, polygon), 'Instanced model footprint stays within the mapped oriented rectangle');
  const box = orientedBox(polygon);
  assert.ok(Math.abs(box.area - 264) < 1e-6);
  assert.ok(Math.min(Math.abs(Math.sin(instance.angle - angle)), Math.abs(Math.cos(instance.angle - angle))) < 1e-8);
  assert.equal(heightFor({ height: '30 feet' }, 'house', 'id').height, 9.144);
  assert.equal(heightFor({ height: '9.5' }, 'house', 'id').height, 9.5);
  assert.equal(heightFor({ 'building:levels': '3' }, 'office', 'id').measured, false);
});

test('residential infill respects mapped parcels, holes, water and streets', () => {
  const data = fixture({ buildings: [], trees: [] });
  const plan = planNeighborhood(data, manifest, { maxTrees: 0 });
  assert.ok(plan.stats.infillBuildings > 0, 'Fixture must exercise the infill path');
  assertInfillPlacement(data, plan);
  for (const kind of ['forest', 'water', 'farmland', 'industrial', 'park']) {
    const noHomes = planNeighborhood(fixture({ buildings: [], trees: [], areas: [{ kind, polygon: rectangle(-220, -220, 220, 220) }] }), manifest, { maxTrees: 0 });
    assert.equal(noHomes.stats.infillBuildings, 0, `Never invent homes in ${kind}`);
  }
});

test('a residential sliver too narrow for a house cannot receive infill', () => {
  const data = fixture({ buildings: [], trees: [], areas: [{ kind: 'residential', polygon: rectangle(-180, 14, 180, 24) }] });
  const plan = planNeighborhood(data, manifest, { maxTrees: 0 });
  assert.equal(plan.stats.infillBuildings, 0, 'Checking the center alone lets buildings hang outside the residential polygon');
});

test('residential infill cannot straddle a water boundary or an inner hole', () => {
  const base = fixture({ buildings: [], trees: [], areas: [{ kind: 'residential', polygon: rectangle(-200, -100, 200, 100) }] });
  const water = { kind: 'water', polygon: rectangle(-20, 20, 20, 80) };
  const waterData = { ...base, areas: [...base.areas, water] };
  assertInfillPlacement(waterData, planNeighborhood(waterData, manifest, { maxTrees: 0 }));
  const holeData = { ...base, areas: [{ ...base.areas[0], holes: [water.polygon] }] };
  assertInfillPlacement(holeData, planNeighborhood(holeData, manifest, { maxTrees: 0 }));
});

test('the body of an infill home cannot project into an angled mapped road', () => {
  const roadOffset = 21 + 24.1 * Math.sqrt(2);
  const data = fixture({ buildings: [], trees: [], areas: [{ kind: 'residential', polygon: rectangle(-220, -220, 220, 220) }], roads: [
    { id: 'way/r', kind: 'residential', width: 6, points: [[-100, 0], [100, 0]] },
    { id: 'way/arterial', kind: 'primary', width: 32, points: [[-180, roadOffset + 180], [180, roadOffset - 180]] },
  ] });
  assertInfillPlacement(data, planNeighborhood(data, manifest, { maxTrees: 0 }));
});

test('dense snapshots obey building and vegetation budgets and prioritize nearby mapped buildings', () => {
  const buildings = Array.from({ length: 900 }, (_, n) => ({ id: `way/dense-${n}`, tags: { building: 'house' }, polygon: rectangle((n % 30 - 15) * 20, (Math.floor(n / 30) - 15) * 20, (n % 30 - 15) * 20 + 11, (Math.floor(n / 30) - 15) * 20 + 14) })).reverse();
  const data = fixture({ radiusM: 700, buildings, roads: [], trees: [], areas: [{ kind: 'forest', polygon: rectangle(-650, -650, 650, 650) }] });
  const plan = planNeighborhood(data, manifest, { maxBuildings: 60, maxTrees: 37 });
  assert.equal(plan.stats.mappedBuildings, 60);
  assert.ok(plan.stats.trees <= 37);
  assert.equal(plan.instances.length, plan.stats.buildings + plan.stats.trees);
  const mapped = plan.instances.filter((i) => i.source === 'mapped');
  assert.ok(mapped.every((i) => Math.hypot(i.x, i.y) < 130), 'A budget must preserve the foreground rather than the input-array prefix');
  assert.ok(plan.instances.every((i) => i.scale.length === 3 && i.scale.every((v) => Number.isFinite(v) && v > 0)));
});

test('crops are generated only on farmland and remain deterministic at small instance budgets', () => {
  const farm = { id: 'land/field', kind: 'farmland', polygon: rectangle(-220, -220, 220, 220) };
  const data = fixture({ buildings: [], roads: [], trees: [], areas: [farm] });
  for (const maxCrops of [0, 1, 2, 7, 11, 30]) {
    const options = { maxTrees: 0, maxCrops };
    const a = planNeighborhood(data, manifest, options), b = planNeighborhood(data, manifest, options);
    assert.ok(a.stats.crops <= maxCrops, `Budget ${maxCrops} produced ${a.stats.crops} crop instances`);
    assert.equal(a.instances.filter((i) => i.kind === 'crop').length, a.stats.crops);
    assert.deepEqual(a.instances, b.instances);
    assertCropPlacement(data, a);
  }
  for (const kind of ['forest', 'water', 'residential', 'industrial', 'orchard', 'park']) {
    const plan = planNeighborhood({ ...data, areas: [{ ...farm, kind }] }, manifest, { maxTrees: 0, maxCrops: 20 });
    assert.equal(plan.stats.crops, 0, `No wheat can be invented in ${kind}`);
  }
});

test('crop clusters do not straddle farmland boundaries, holes, water or roads', () => {
  const farm = { id: 'land/crop-edge', kind: 'farmland', polygon: rectangle(-200, -200, 200, 200) };
  const base = fixture({ buildings: [], roads: [], trees: [], areas: [farm] });
  const sliver = { ...base, areas: [{ ...farm, polygon: rectangle(-200, -2.1, 200, -1.9) }] };
  const sliverPlan = planNeighborhood(sliver, manifest, { maxTrees: 0, maxCrops: 100 });
  assert.equal(sliverPlan.stats.crops, 0, 'A crop footprint cannot fit in a 20 cm-wide farmland sliver');
  const water = { id: 'water/crop-edge', kind: 'water', polygon: rectangle(10, -100, 30, 100) };
  const waterData = { ...base, areas: [farm, water] };
  const waterPlan = planNeighborhood(waterData, manifest, { maxTrees: 0, maxCrops: 1000 });
  assert.ok(waterPlan.stats.crops > 0, 'Containment fixture must retain visible crops');
  assertCropPlacement(waterData, waterPlan);
  const holeData = { ...base, areas: [{ ...farm, holes: [water.polygon] }] };
  assertCropPlacement(holeData, planNeighborhood(holeData, manifest, { maxTrees: 0, maxCrops: 1000 }));
  const roadData = { ...base, roads: [{ id: 'way/crop-road', kind: 'primary', width: 6, points: [[13, -220], [13, 220]] }] };
  assertCropPlacement(roadData, planNeighborhood(roadData, manifest, { maxTrees: 0, maxCrops: 1000 }));
});

test('the authored model kit has valid mesh references, measured dimensions and reusable scene nodes', () => {
  const { gltf, values } = verifyGlb(kit);
  assert.ok(manifest.models.length >= 28);
  for (const kind of ['house', 'apartment', 'office', 'shop', 'warehouse', 'farm', 'tree']) assert.ok(manifest.models.some((m) => m.kind === kind));
  for (const model of manifest.models) {
    const node = gltf.nodes[model.nodeIndex], mesh = gltf.meshes[model.meshIndex];
    assert.equal(node.mesh, model.meshIndex);
    assert.equal(node.name, model.id);
    assert.equal(node.matrix, undefined); assert.equal(node.translation, undefined); assert.equal(node.rotation, undefined); assert.equal(node.scale, undefined);
    const minima = [Infinity, Infinity, Infinity], maxima = [-Infinity, -Infinity, -Infinity];
    for (const primitive of mesh.primitives) {
      const positions = values[primitive.attributes.POSITION];
      for (let i = 0; i < positions.length; i++) { const axis = i % 3; minima[axis] = Math.min(minima[axis], positions[i]); maxima[axis] = Math.max(maxima[axis], positions[i]); }
    }
    for (const [axis, size] of [[0, model.width], [1, model.height], [2, model.depth]]) assert.ok(Math.abs(maxima[axis] - minima[axis] - size) < 1e-4);
    assert.ok(Math.abs(minima[1]) < 1e-5, 'Models rest at ground Y=0');
  }
});

test('generated GLB instance accessors match the plan, with correct East/North conversion and unit rotations', () => {
  const data = fixture(), options = { maxBuildings: 100, maxTrees: 40 };
  const plan = planNeighborhood(data, manifest, options), result = buildNeighborhoodGlb(data, manifest, kit, options);
  const { terrainAvailable, ...instanceStats } = result.stats;
  assert.equal(terrainAvailable, false);
  assert.deepEqual(instanceStats, plan.stats);
  const { gltf, values } = verifyGlb(result.buffer), parsed = readGlb(result.buffer);
  assert.deepEqual(parsed.json, gltf);
  assert.ok(gltf.extensionsRequired.includes('EXT_mesh_gpu_instancing'));
  const expectedGroups = new Map();
  for (const i of plan.instances) {
    const key = `${i.model}:${i.palette}`;
    if (!expectedGroups.has(key)) expectedGroups.set(key, []);
    expectedGroups.get(key).push(i);
  }
  let total = 0;
  for (const node of gltf.nodes) {
    const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (!attributes) continue;
    const expected = expectedGroups.get(node.name);
    assert.ok(expected, `Unknown instance group ${node.name}`);
    const translation = gltf.accessors[attributes.TRANSLATION], rotation = gltf.accessors[attributes.ROTATION], scale = gltf.accessors[attributes.SCALE];
    assert.equal(translation.count, expected.length); assert.equal(rotation.count, expected.length); assert.equal(scale.count, expected.length);
    assert.equal(translation.type, 'VEC3'); assert.equal(rotation.type, 'VEC4'); assert.equal(scale.type, 'VEC3');
    const tp = values[attributes.TRANSLATION], rp = values[attributes.ROTATION], sp = values[attributes.SCALE];
    for (let i = 0; i < expected.length; i++) {
      const source = expected[i];
      assert.ok(Math.abs(tp[i * 3] - source.x) < 1e-4);
      assert.ok(Math.abs(tp[i * 3 + 2] + source.y) < 1e-4, 'North becomes negative Z in Y-up glTF');
      assert.ok(Math.abs(tp[i * 3 + 1] - (4 - (source.x ** 2 + source.y ** 2) / (2 * 6371000))) < 1e-4);
      assert.ok(Math.abs(Math.hypot(...rp.slice(i * 4, i * 4 + 4)) - 1) < 1e-5);
      assert.equal(rp[i * 4], 0); assert.equal(rp[i * 4 + 2], 0);
      assert.ok(Math.abs(rp[i * 4 + 1] - Math.sin(source.angle / 2)) < 1e-6);
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(sp[i * 3 + j] - source.scale[j]) < 1e-5 && sp[i * 3 + j] > 0);
    }
    total += expected.length;
  }
  assert.equal(total, plan.instances.length);
  assert.equal(expectedGroups.size, gltf.nodes.filter((n) => n.extensions?.EXT_mesh_gpu_instancing).length);
});

test('available DEM elevation changes instance bases while missing terrain stays explicitly unavailable', () => {
  const data = fixture({ buildings: [fixture().buildings[0]], roads: [], areas: [], trees: [] });
  const elevation = { status: 'available', width: 2, height: 2, extentM: [-260, -260, 260, 260], heights: [100, 110, 120, 130] };
  const result = buildNeighborhoodGlb(data, manifest, kit, { elevation, maxTrees: 0, maxCrops: 0 });
  assert.equal(result.stats.terrainAvailable, true);
  const { gltf, values } = verifyGlb(result.buffer);
  const node = gltf.nodes.find((n) => n.extensions?.EXT_mesh_gpu_instancing);
  const translation = values[node.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION];
  const absolute = 100 + (70 + 260) / 520 * 10 + (65 + 260) / 520 * 20;
  const expected = 4 + absolute - (70 ** 2 + 65 ** 2) / (2 * 6371000);
  assert.ok(Math.abs(translation[1] - expected) < 1e-4, 'Building base uses bilinear absolute DEM elevation');
  assert.ok(result.focusHeight > 100);
});

test('the saved real Colossus 1 snapshot generates a bounded, valid instanced neighborhood', () => {
  const data = JSON.parse(readFileSync(new URL('../data/cloudshadow/neighborhoods/colossus1.json', import.meta.url)));
  assert.equal(data.source.name, 'OpenStreetMap');
  assert.ok(data.buildings.length > 100 && data.roads.length > 100);
  const result = buildNeighborhoodGlb(data, manifest, kit, { maxBuildings: 140, maxTrees: 100 });
  assert.ok(result.stats.mappedBuildings > 0 && result.stats.buildings <= 140);
  assert.ok(result.stats.trees <= 100);
  assert.ok(result.stats.modelVariants > 3);
  assert.equal(result.center.lat, data.center.lat);
  assert.equal(result.center.lon, data.center.lon);
  assert.ok(Number.isFinite(result.focus.x) && Number.isFinite(result.focus.y));
  const { gltf } = verifyGlb(result.buffer);
  const instanced = gltf.nodes.filter((n) => n.extensions?.EXT_mesh_gpu_instancing);
  assert.ok(instanced.length > 3);
  assert.ok(gltf.nodes.some((n) => n.name === 'mapped-ground-and-streets'));
});
