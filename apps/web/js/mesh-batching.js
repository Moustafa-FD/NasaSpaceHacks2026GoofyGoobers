// Collapse an authored color-only model into one GPU draw primitive. Input
// factors use the kit's display-RGB palette; output COLOR_0 is linear RGBA.
// Read only original-kit buffers: callers add per-scene attributes afterwards.
const WIDTHS = { SCALAR: 1, VEC3: 3, VEC4: 4 };
const COMPONENTS = { 5123: { bytes: 2, read: 'getUint16' }, 5125: { bytes: 4, read: 'getUint32' }, 5126: { bytes: 4, read: 'getFloat32' } };

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`Mesh batching: invalid ${label}`);
  return value;
}

function sourceAccessor(gltf, binary, index, label, types, components) {
  integer(index, `${label} accessor index`);
  const accessor = gltf.accessors?.[index];
  if (!accessor || accessor.sparse) throw new Error(`Mesh batching: missing or sparse ${label} accessor`);
  if (!types.includes(accessor.type) || !components.includes(accessor.componentType) || accessor.normalized) {
    throw new Error(`Mesh batching: unsupported ${label} accessor format`);
  }
  const width = WIDTHS[accessor.type], format = COMPONENTS[accessor.componentType];
  const count = integer(accessor.count, `${label} accessor count`, 1);
  const view = gltf.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) throw new Error(`Mesh batching: ${label} must use the original BIN buffer`);
  const elementBytes = width * format.bytes;
  if (view.byteStride !== undefined && view.byteStride !== elementBytes) throw new Error(`Mesh batching: interleaved ${label} accessors are unsupported`);
  const viewOffset = integer(view.byteOffset ?? 0, `${label} buffer-view offset`);
  const viewLength = integer(view.byteLength, `${label} buffer-view length`, 1);
  const offset = integer(accessor.byteOffset ?? 0, `${label} accessor offset`);
  const bytesNeeded = count * elementBytes;
  if (offset % format.bytes || viewOffset % format.bytes || offset + bytesNeeded > viewLength || viewOffset + viewLength > binary.byteLength) {
    throw new Error(`Mesh batching: ${label} accessor exceeds or misaligns its source buffer`);
  }
  const source = new DataView(binary.buffer, binary.byteOffset + viewOffset + offset, bytesNeeded);
  const values = new Array(count * width);
  for (let i = 0; i < values.length; i++) {
    const value = source[format.read](i * format.bytes, true);
    if (!Number.isFinite(value)) throw new Error(`Mesh batching: non-finite ${label} value`);
    values[i] = value;
  }
  return { count, width, values };
}

/**
 * Bake an unskinned, non-interleaved triangle mesh from the original kit BIN.
 * addAccessor(values, width, componentType?) appends to the caller's GLB and
 * returns its accessor index. POSITION/NORMAL/COLOR_0 are FLOAT; indices UINT.
 * Material differences are baked into colors, normals remain unsmoothed, and
 * alpha/double-sided flags are retained. Palette changes must precede this call.
 */
export function bakeMesh(gltf, bin, mesh, addAccessor) {
  if (!mesh || !Array.isArray(mesh.primitives) || !mesh.primitives.length || mesh.weights) throw new Error('Mesh batching: expected a static mesh with primitives');
  if (typeof addAccessor !== 'function') throw new Error('Mesh batching: addAccessor callback is required');
  const binary = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const positions = [], normals = [], colors = [], indices = [];
  let vertexOffset = 0, doubleSided = false, alphaMode = 'OPAQUE', alphaCutoff;
  for (const primitive of mesh.primitives) {
    if ((primitive.mode ?? 4) !== 4 || primitive.targets) throw new Error('Mesh batching: only static triangle primitives are supported');
    for (const name of Object.keys(primitive.attributes || {})) if (!['POSITION', 'NORMAL', 'COLOR_0'].includes(name)) {
      throw new Error(`Mesh batching: unsupported source attribute ${name}; add scene attributes after baking`);
    }
    const p = sourceAccessor(gltf, binary, primitive.attributes?.POSITION, 'POSITION', ['VEC3'], [5126]);
    const n = sourceAccessor(gltf, binary, primitive.attributes?.NORMAL, 'NORMAL', ['VEC3'], [5126]);
    if (n.count !== p.count) throw new Error('Mesh batching: POSITION and NORMAL counts differ');
    const sourceColors = primitive.attributes.COLOR_0 === undefined ? null : sourceAccessor(gltf, binary, primitive.attributes.COLOR_0, 'COLOR_0', ['VEC3', 'VEC4'], [5126]);
    if (sourceColors && sourceColors.count !== p.count) throw new Error('Mesh batching: POSITION and COLOR_0 counts differ');
    const index = sourceAccessor(gltf, binary, primitive.indices, 'indices', ['SCALAR'], [5123, 5125]);
    if (index.count % 3) throw new Error('Mesh batching: index count must describe triangles');
    const material = gltf.materials?.[primitive.material] || {};
    const pbr = material.pbrMetallicRoughness || {};
    if (pbr.baseColorTexture || pbr.metallicRoughnessTexture || material.normalTexture || material.occlusionTexture || material.emissiveTexture) {
      throw new Error('Mesh batching: textured source materials are unsupported');
    }
    const factor = pbr.baseColorFactor || [1, 1, 1, 1];
    if (factor.length !== 4 || factor.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('Mesh batching: invalid baseColorFactor');
    const linear = factor.slice(0, 3).map((v) => Math.pow(v, 2.2));
    doubleSided ||= material.doubleSided === true;
    if (material.alphaMode === 'BLEND') alphaMode = 'BLEND';
    if (material.alphaMode === 'MASK') {
      const cutoff = material.alphaCutoff ?? 0.5;
      if (alphaCutoff !== undefined && cutoff !== alphaCutoff) throw new Error('Mesh batching: incompatible alpha-mask cutoffs');
      alphaCutoff = cutoff;
      if (alphaMode !== 'BLEND') alphaMode = 'MASK';
    }
    for (const value of p.values) positions.push(value);
    for (const value of n.values) normals.push(value);
    for (let i = 0; i < p.count; i++) {
      // glTF vertex colors are already linear; only display-RGB material factors
      // need conversion. Preserve an existing vertex alpha independently.
      const sourceOffset = i * (sourceColors?.width || 0);
      for (let c = 0; c < 3; c++) colors.push(linear[c] * (sourceColors ? sourceColors.values[sourceOffset + c] : 1));
      colors.push(factor[3] * (sourceColors?.width === 4 ? sourceColors.values[sourceOffset + 3] : 1));
    }
    for (const value of index.values) {
      if (!Number.isInteger(value) || value < 0 || value >= p.count) throw new Error('Mesh batching: source index exceeds its primitive vertex count');
      indices.push(value + vertexOffset);
    }
    vertexOffset += p.count;
  }
  const attributes = { POSITION: addAccessor(positions, 3), NORMAL: addAccessor(normals, 3), COLOR_0: addAccessor(colors, 4) };
  const mergedIndices = addAccessor(indices, 1, 5125);
  const material = { name: `baked-${mesh.name || 'model'}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided };
  if (alphaMode !== 'OPAQUE') material.alphaMode = alphaMode;
  if (alphaMode === 'MASK') material.alphaCutoff = alphaCutoff;
  gltf.materials ||= [];
  const materialIndex = gltf.materials.length; gltf.materials.push(material);
  return { ...mesh, primitives: [{ attributes, indices: mergedIndices, material: materialIndex, mode: 4 }] };
}
