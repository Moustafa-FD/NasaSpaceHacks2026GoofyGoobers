import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grassCoordinateFrame, grassWorldCoordinate, grassMaterialDomain,
  grassDetailWeight, groundMaterialDomain, groundMaterialWeights,
  GROUND_MATERIAL_SCALES, createLandscapeShader,
  LANDSCAPE_VERTEX_SHADER, LANDSCAPE_FRAGMENT_SHADER,
} from '../apps/web/js/landscape-shader.js';

const EARTH = 6378137, RAD = Math.PI / 180;
const localPoint = (center, point) => [
  (point.lon - center.lon) * RAD * EARTH * Math.cos(center.lat * RAD),
  (point.lat - center.lat) * RAD * EARTH,
];
const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} versus ${b}`);

test('continuous grass is restricted to unflooded green ground, never structures, crops, trees or water', () => {
  const green = [.14, .31, .09];
  assert.equal(grassMaterialDomain(3, green), true);
  for (const kind of [0, 1, 2, 2.5, 3.5, 4]) assert.equal(grassMaterialDomain(kind, green), false);
  for (const color of [[.3, .3, .3], [.4, .3, .12], [.1, .3, .4]]) {
    assert.equal(grassMaterialDomain(3, color), false);
  }
  assert.equal(grassMaterialDomain(3, green, true), false);
});

test('all natural ground colors receive material treatment while other categories and flooding remain excluded', () => {
  assert.equal(groundMaterialDomain(3), true);
  assert.equal(groundMaterialDomain(3, true), false);
  for (const kind of [0, 1, 2, 2.5, 3.5, 4]) assert.equal(groundMaterialDomain(kind), false);
});

test('linear display colors select plausible grass, dry soil, rock and sand appearances', () => {
  const fixtures = [
    {color: [.48, .58, .37], expected: 0}, // Existing grass anchor.
    {color: [.29, .41, .25], expected: 0}, // Existing forest anchor.
    {color: [.62, .59, .38], expected: 1}, // Existing farmland anchor.
    {color: [.46, .32, .19], expected: 1},
    {color: [.55, .53, .52], expected: 2},
    {color: [.82, .76, .59], expected: 3},
  ];
  for (const {color, expected} of fixtures) {
    const weights = groundMaterialWeights(color.map(value => value ** 2.2));
    assert.ok(weights[expected] > .8, `${color}: ${weights}`);
    near(weights.reduce((sum, value) => sum + value, 0), 1);
    assert.ok(weights.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.deepEqual(groundMaterialWeights([0, 0, 0]), [0, 0, 1, 0]);
});

test('ground material transitions are continuous across blended green, dry, neutral and sandy colors', () => {
  const palette = [[.48,.58,.37],[.62,.59,.38],[.46,.32,.19],[.55,.53,.52],[.82,.76,.59]];
  for (let pair = 0; pair < palette.length - 1; pair++) {
    const a = palette[pair].map(value => value ** 2.2), b = palette[pair + 1].map(value => value ** 2.2);
    let previous = groundMaterialWeights(a);
    for (let step = 1; step <= 1000; step++) {
      const t = step / 1000;
      const weights = groundMaterialWeights(a.map((value, channel) => value * (1 - t) + b[channel] * t));
      near(weights.reduce((sum, value) => sum + value, 0), 1);
      for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(weights[channel] - previous[channel]) < .02);
      previous = weights;
    }
  }
});

test('material feature sizes stay physically small compared with buildings', () => {
  assert.ok(GROUND_MATERIAL_SCALES.bladeLengthM < .1);
  assert.ok(GROUND_MATERIAL_SCALES.grainM < .25);
  assert.equal(GROUND_MATERIAL_SCALES.tuftM, .5);
  assert.ok(GROUND_MATERIAL_SCALES.patchM >= 4 && GROUND_MATERIAL_SCALES.patchM <= 16);
  assert.ok(GROUND_MATERIAL_SCALES.broadM > GROUND_MATERIAL_SCALES.patchM);
});

test('adjacent source patches share the same geographic grass phase despite different east scales', () => {
  const point = {lat: 39.005, lon: -76.995};
  const centers = [{lat: 39, lon: -77}, {lat: 39.01, lon: -76.99}];
  const phases = centers.map(center => grassWorldCoordinate(grassCoordinateFrame(center), ...localPoint(center, point)));
  near(phases[0][0], phases[1][0]);
  near(phases[0][1], phases[1][1]);
  for (const center of [...centers, {lat: -33.8, lon: 151.2}, {lat: 70, lon: -179.99}]) {
    const frame = grassCoordinateFrame(center);
    assert.ok(frame.origin.every(value => value >= 0 && value < frame.period));
    const phase = grassWorldCoordinate(frame, -2300, 1700);
    const repeated = grassWorldCoordinate(frame, -2300 + frame.period / frame.scale[0], 1700 + frame.period);
    near(phase[0], repeated[0]);
    near(phase[1], repeated[1]);
  }
});

test('subpixel blade detail fades monotonically before it can alias into distant stripes', () => {
  const footprints = [0, .01, .03, .05, .07, .1, .13, 1, 20];
  const weights = footprints.map(grassDetailWeight);
  assert.equal(weights[0], 1);
  assert.ok(weights[4] > 0 && weights[4] < 1);
  assert.equal(weights.at(-1), 0);
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] <= weights[i - 1]);
  assert.equal(grassDetailWeight(.13), 0);
});

test('grass keeps one shader while the DEM and initially transparent evidence use bounded samplers', () => {
  class Vector { constructor(...values) { this.values = values; } }
  class Options { constructor(options) { Object.assign(this, options); } }
  const Cesium = {
    Cartesian2: Vector, Cartesian3: Vector, Cartesian4: Vector,
    CustomShader: Options, TextureUniform: Options,
    CustomShaderMode: {MODIFY_MATERIAL: 'modify'},
    UniformType: {FLOAT: 'float', VEC2: 'vec2', VEC3: 'vec3', VEC4: 'vec4', SAMPLER_2D: 'sampler'},
    VaryingType: {FLOAT: 'float', VEC2: 'vec2'}, PixelFormat: {RGBA: 'rgba'},
    PixelDatatype: {UNSIGNED_BYTE: 'byte'},
    TextureMinificationFilter: {NEAREST: 'nearest'}, TextureMagnificationFilter: {NEAREST: 'nearest'},
  };
  const center = {lat: 39.0298, lon: -77.4744};
  const shader = createLandscapeShader(Cesium, null, {center});
  const frame = grassCoordinateFrame(center);
  assert.deepEqual(shader.uniforms.u_grassOrigin.value.values, frame.origin);
  assert.deepEqual(shader.uniforms.u_grassScale.value.values, frame.scale);
  assert.equal(Object.values(shader.uniforms).filter(uniform => uniform.type === 'sampler').length, 2);
  assert.equal(shader.uniforms.u_evidenceActive.value,0);
  assert.deepEqual([...shader.uniforms.u_evidence.value.typedArray],[0,0,0,0]);
  assert.equal(shader.vertexShaderText, LANDSCAPE_VERTEX_SHADER);
  assert.equal(shader.fragmentShaderText, LANDSCAPE_FRAGMENT_SHADER);
  assert.doesNotMatch(LANDSCAPE_VERTEX_SHADER, /lpGrass/);
});

test('ground remains an opaque color treatment with NDVI response and final flood-water priority', () => {
  const ground = LANDSCAPE_FRAGMENT_SHADER.split('vec2 lpGroundMaterial')[1].split('void fragmentMain')[0];
  assert.match(ground, /fwidth\(local\*u_grassScale\)/);
  assert.match(ground, /smoothstep\(0\.24,0\.80,footprint\)/);
  assert.match(ground, /smoothstep\(0\.125,0\.90,metresPerPixel\)/);
  assert.doesNotMatch(ground, /discard|alpha|position|gl_FragDepth|texture\(/);
  assert.match(LANDSCAPE_FRAGMENT_SHADER, /else if \(kind > 2\.5 && kind < 3\.5\)/);
  assert.match(LANDSCAPE_FRAGMENT_SHADER, /0\.55\+0\.45\*health/);
  assert.match(LANDSCAPE_FRAGMENT_SHADER, /groundWeights=lpGroundWeights\(original\)/);
  assert.match(LANDSCAPE_FRAGMENT_SHADER, /if\(!floodedGround\)\s*\{\s*vec2 ground=lpGroundMaterial/);
  assert.ok(LANDSCAPE_FRAGMENT_SHADER.indexOf('|| floodedGround)') > LANDSCAPE_FRAGMENT_SHADER.indexOf('material.diffuse*=ground.x'));
});
