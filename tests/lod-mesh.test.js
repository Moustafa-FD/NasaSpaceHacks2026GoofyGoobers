import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { coarseMesh } from '../apps/web/js/lod-mesh.js';

const manifest = JSON.parse(readFileSync(new URL('../apps/web/assets/low-poly/manifest.json', import.meta.url)));
const buildingKinds = new Set(['house', 'apartment', 'office', 'shop', 'warehouse', 'farm', 'civic', 'data-center']);
const models = manifest.models.filter((m) => buildingKinds.has(m.kind) || ['tree', 'shrub'].includes(m.kind));

function generate(template, palette = 0) {
  const accessors = [], gltf = { materials: [] };
  const add = (values, width, componentType = 5126) => {
    const index = accessors.length;
    accessors.push({ values, width, componentType, count: values.length / width });
    return index;
  };
  const mesh = coarseMesh(template, add, gltf, palette);
  assert.equal(mesh.primitives.length, 1, `${template.id}: one coarse draw primitive`);
  const primitive = mesh.primitives[0];
  return { mesh, primitive, material: gltf.materials[primitive.material], positions: accessors[primitive.attributes.POSITION], normals: accessors[primitive.attributes.NORMAL], colors: accessors[primitive.attributes.COLOR_0], indices: accessors[primitive.indices] };
}

function vector(array, index) { return array.slice(index * 3, index * 3 + 3); }
function subtract(a, b) { return a.map((v, i) => v - b[i]); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

test('all authored building and tree families have smaller valid distance meshes within their source extents', () => {
  assert.ok(models.length > 40);
  for (const model of models) {
    const generated = generate(model), { positions, normals, colors, indices } = generated;
    assert.ok(positions.count > 0 && indices.count > 0, model.id);
    assert.equal(positions.width, 3); assert.equal(normals.width, 3); assert.equal(colors.width, 4);
    assert.equal(normals.count, positions.count); assert.equal(colors.count, positions.count);
    assert.equal(indices.width, 1); assert.equal(indices.componentType, 5125);
    assert.equal(indices.count % 3, 0);
    assert.ok(indices.count / 3 < model.triangles, `${model.id}: distance mesh must reduce triangles`);
    assert.ok(indices.values.every((i) => Number.isInteger(i) && i >= 0 && i < positions.count));
    assert.ok([...positions.values, ...normals.values, ...colors.values].every(Number.isFinite));
    const minima = [Infinity, Infinity, Infinity], maxima = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.values.length; i++) { const axis = i % 3; minima[axis] = Math.min(minima[axis], positions.values[i]); maxima[axis] = Math.max(maxima[axis], positions.values[i]); }
    for (let axis = 0; axis < 3; axis++) assert.ok(maxima[axis] > minima[axis], `${model.id}: nonempty extent on axis ${axis}`);
    assert.ok(minima[0] >= -model.width / 2 - 1e-6 && maxima[0] <= model.width / 2 + 1e-6, `${model.id}: X extent`);
    assert.ok(minima[2] >= -model.depth / 2 - 1e-6 && maxima[2] <= model.depth / 2 + 1e-6, `${model.id}: Z extent`);
    assert.ok(Math.abs(minima[1]) < 1e-8 && maxima[1] <= model.height + 1e-6, `${model.id}: ground-aligned Y extent`);
  }
});

test('coarse triangles are nondegenerate and retain outward winding with flat unit normals', () => {
  for (const model of models) {
    const { positions, normals, indices } = generate(model);
    for (let i = 0; i < indices.values.length; i += 3) {
      const ids = indices.values.slice(i, i + 3), points = ids.map((j) => vector(positions.values, j));
      const normal = vector(normals.values, ids[0]);
      assert.deepEqual(normal, vector(normals.values, ids[1]), `${model.id}: flat face normal`);
      assert.deepEqual(normal, vector(normals.values, ids[2]), `${model.id}: flat face normal`);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-8, `${model.id}: unit normal`);
      const geometric = cross(subtract(points[1], points[0]), subtract(points[2], points[0])), area = Math.hypot(...geometric);
      assert.ok(area > 1e-8, `${model.id}: no zero-area triangles`);
      assert.ok(geometric.every((v, j) => Math.abs(v / area - normal[j]) < 1e-8), `${model.id}: winding agrees with normals`);
      assert.ok(normal[1] >= -1e-8, `${model.id}: no downward roof or crown faces`);
      if (buildingKinds.has(model.kind)) {
        const centroid = [0, 1, 2].map((j) => points.reduce((sum, p) => sum + p[j], 0) / 3);
        const outward = subtract(centroid, [0, model.height * 0.36, 0]);
        assert.ok(normal.reduce((sum, v, j) => sum + v * outward[j], 0) > 0, `${model.id}: faces point away from building interior`);
      } else if (model.style !== 'grove' && normal[1] < 0.999) {
        const x = points.reduce((sum, p) => sum + p[0], 0) / 3, z = points.reduce((sum, p) => sum + p[2], 0) / 3;
        assert.ok(normal[0] * x + normal[2] * z > 0, `${model.id}: trunk/crown points outward`);
      }
    }
  }
});

test('distance materials use linear vertex colors, opaque white PBR and deterministic palettes', () => {
  const house = models.find((m) => m.kind === 'house');
  const variants = [];
  for (let palette = 0; palette < 4; palette++) {
    const first = generate(house, palette), repeated = generate(house, palette);
    assert.deepEqual(first.positions, repeated.positions);
    assert.deepEqual(first.colors, repeated.colors);
    assert.deepEqual(first.material.pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1]);
    assert.equal(first.material.pbrMetallicRoughness.metallicFactor, 0);
    assert.equal(first.material.doubleSided, false);
    assert.ok(first.colors.values.every((v) => v >= 0 && v <= 1));
    for (let i = 3; i < first.colors.values.length; i += 4) assert.equal(first.colors.values[i], 1);
    variants.push(first.colors.values.slice(0, 3));
  }
  assert.equal(new Set(variants.map((v) => v.join(','))).size, 4, 'Palette variation survives distance substitution');
  const expected = [0.70, 0.74, 0.63].map((v) => v ** 2.2);
  assert.deepEqual(variants[0], expected, 'Display RGB is converted to linear exactly once');
});

test('a grove remains a multi-crown silhouette instead of one enlarged tree', () => {
  const grove = manifest.models.find((m) => m.style === 'grove'), single = manifest.models.find((m) => m.id === 'tree-maple');
  const clustered = generate(grove), individual = generate(single);
  assert.ok(clustered.indices.count > individual.indices.count * 6);
  assert.ok(clustered.indices.count / 3 < grove.triangles);
  assert.ok(clustered.positions.values.some((v, i) => i % 3 === 0 && v > grove.width * 0.35));
  assert.ok(clustered.positions.values.some((v, i) => i % 3 === 0 && v < -grove.width * 0.35));
});
