import { sampleElevation } from "./landscape.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);

// A qualitative trace for documented combustion, never a concentration or visible-smoke estimate.
export function emissionPolicy(site, year, row = {}, phase = "observed") {
  const onsetText = String(site?.onset || "");
  const onset = /^\d{4}(?:-|$)/.test(onsetText) ? Number(onsetText.slice(0, 4)) : null;
  const eligible = site?.effects?.plume === true && finite(year) && onset !== null && year >= onset;
  const windSpeed = row.WS10M == null || row.WS10M === "" ? null : Number(row.WS10M);
  const direction = row.PlumeTowardDeg == null || row.PlumeTowardDeg === "" ? null : Number(row.PlumeTowardDeg);
  const hasWind = Number.isFinite(windSpeed) && windSpeed >= 0 && Number.isFinite(direction);
  return {
    eligible,
    emissionRate: eligible ? phase === "projected" ? 3 : 4 : 0,
    windSpeedMs: hasWind ? Math.min(40, windSpeed) : 0,
    windTowardDeg: hasWind ? ((direction % 360) + 360) % 360 : null,
    illustrative: true,
  };
}

function smokeImage() {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 48;
  const context = canvas.getContext("2d"), gradient = context.createRadialGradient(24, 24, 0, 24, 24, 24);
  gradient.addColorStop(0, "rgba(255,255,255,.8)");
  gradient.addColorStop(0.35, "rgba(255,255,255,.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient; context.fillRect(0, 0, 48, 48);
  return canvas;
}

export function attachCampusEffects(viewer, site, sceneData) {
  const systems = [];
  let active = false, destroyed = false, year = null, row = {}, phase = "observed", wind;
  let frame, image;
  const candidates = (sceneData?.campuses || []).filter((campus) => [campus.x, campus.y, campus.width, campus.depth].every(finite) && campus.width > 0 && campus.depth > 0)
    .sort((a, b) => a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y);
  const campus = candidates[0];
  const center = sceneData?.center;

  function createSources() {
    if (systems.length || !campus || !finite(center?.lat) || !finite(center?.lon)) return;
    const C = Cesium;
    frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(center.lon, center.lat));
    image = smokeImage(); wind = new C.Cartesian3();
    const count = Math.min(3, Math.max(1, Math.floor(campus.width / 45)));
    const angle = finite(campus.angle) ? campus.angle : 0, cos = Math.cos(angle), sin = Math.sin(angle);
    for (let i = 0; i < count; i++) {
      // The yard edge is illustrative; no turbine/stack locations are claimed as observations.
      const east = (i - (count - 1) / 2) * Math.min(18, campus.width * 0.2), north = campus.depth / 2 + 12;
      const x = campus.x + east * cos - north * sin, y = campus.y + east * sin + north * cos;
      const base = 4 + (sampleElevation(sceneData.elevation, x, y) ?? 0) - (x * x + y * y) / (2 * 6371000);
      const source = new C.ParticleSystem({
        // Cesium 1.121 emits floor((dt % lifetime) * emissionRate). A finite
        // loop bounds catch-up after clock jumps or a hidden source resumes;
        // individual particles still keep their own 10–15 second lifetimes.
        image, show: false, emissionRate: 0, loop: true, lifetime: 8,
        minimumParticleLife: 10, maximumParticleLife: 15, minimumSpeed: 0.3, maximumSpeed: 0.8,
        imageSize: new C.Cartesian2(8, 8), sizeInMeters: true, startScale: 0.45, endScale: 1.5,
        startColor: new C.Color(0.7, 0.74, 0.76, 0.38), endColor: new C.Color(0.7, 0.74, 0.76, 0),
        emitter: new C.CircleEmitter(1.5),
        modelMatrix: C.Matrix4.multiplyByTranslation(frame, new C.Cartesian3(x, y, base + 6), new C.Matrix4()),
        updateCallback(particle) {
          C.Cartesian3.clone(wind, particle.velocity);
          const age = finite(particle.age) && finite(particle.life) && particle.life > 0 ? Math.max(0, Math.min(1, particle.age / particle.life)) : 0;
          const alpha = age > 0 && age < 1 ? Math.sin(Math.PI * age) * 0.3 : 0;
          // Cesium.Particle has startColor/endColor; its billboard lerps them.
          particle.startColor.alpha = particle.endColor.alpha = alpha;
        },
      });
      systems.push(viewer.scene.primitives.add(source));
    }
  }
  function refresh() {
    if (destroyed) return;
    const policy = emissionPolicy(site, year, row, phase), visible = active && policy.eligible;
    if (visible && !systems.length) createSources();
    if (frame && wind) {
      const bearing = (policy.windTowardDeg || 0) * Math.PI / 180, speed = policy.windSpeedMs * 1.4;
      Cesium.Matrix4.multiplyByPointAsVector(frame, new Cesium.Cartesian3(Math.sin(bearing) * speed, Math.cos(bearing) * speed, 2.6), wind);
    }
    for (const source of systems) { source.show = visible; source.emissionRate = visible ? policy.emissionRate : 0; }
  }
  return {
    setActive(value) { if (!destroyed) { active = !!value; refresh(); } },
    setYear(value, values = {}, selectedPhase = "observed") { if (!destroyed) { year = value; row = values || {}; phase = selectedPhase; refresh(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const source of systems) viewer.scene.primitives.remove(source);
      systems.length = 0; image = frame = wind = null;
    },
  };
}
