// The EXR preprocessing retains a conservative linear-HDR ambient color. It is
// isotropic diffuse lighting, not a claim of prefiltered specular reflections.
export function validSkyCoefficients(environment) {
  const values=environment?.diffuseSH;
  return Array.isArray(values)&&values.length===9&&values.every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite));
}
export function applySkyLighting(Cesium,model,environment) {
  if(!model?.imageBasedLighting||!validSkyCoefficients(environment))return false;
  model.imageBasedLighting.sphericalHarmonicCoefficients=environment.diffuseSH.map(v=>new Cesium.Cartesian3(...v));
  model.imageBasedLighting.imageBasedLightingFactor=new Cesium.Cartesian2(.55,.7);
  return true;
}
