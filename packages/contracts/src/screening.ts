/** Additive, explicitly sourced screening inputs; no automatic facility parameters. */
export interface ScreeningSource { evidence: "reported" | "assumed"; citation: string; url?: string }
export interface ScreeningYear {
  year: number; source?: ScreeningSource; pollutant?: string;
  heatMw?: number; emissionRateGs?: number; withdrawalM3s?: number; returnM3s?: number; riverFlowM3s?: number;
  upstreamTempC?: number; dischargeTempC?: number; upstreamMgL?: number; dischargeMgL?: number; soundPowerDbA?: number;
}
export interface EnvironmentScreeningRequest {
  schemaVersion: "1.0"; kind: "environment-screening"; siteId?: string; point?: { latitude: number; longitude: number };
  years: ScreeningYear[];
  dispersion?: { effectiveHeightM: number; landUse: "urban" | "rural"; airDensityKgM3?: number; specificHeatJkgK?: number; source: ScreeningSource };
  receptors?: Array<{ name: string; distanceM: number }>;
  noiseContourLevelsDbA?: number[];
  backgroundNoise?: { dbA: number; source: ScreeningSource };
}
export const SCREENING_INPUTS = {
  heat: { fields: ["heatMw", "dispersion.effectiveHeightM", "dispersion.airDensityKgM3", "dispersion.specificHeatJkgK"], units: "MW; m; kg/m³; J/(kg·K)", description: "Sensible heat released to air, using a passive-tracer approximation. No buoyancy, building or cooling-system physics." },
  air: { fields: ["emissionRateGs", "pollutant", "dispersion.effectiveHeightM"], units: "g/s; pollutant identity; m", description: "Supplied annual emission/operation scenarios scaled by NASA-wind dilution. No chemistry or future wind forecast." },
  waterBalance: { fields: ["withdrawalM3s", "returnM3s"], units: "m³/s annual-average scenario rates", description: "Withdrawal minus returned water within the stated accounting boundary, not source depletion or scarcity." },
  waterTemperature: { fields: ["riverFlowM3s", "returnM3s", "upstreamTempC", "dischargeTempC"], units: "m³/s; °C", description: "Steady complete mixing at the discharge, equal water density/heat capacity, no heat exchange." },
  waterQuality: { fields: ["riverFlowM3s", "returnM3s", "upstreamMgL", "dischargeMgL", "pollutant"], units: "m³/s; mg/L; constituent identity", description: "Conservative constituent complete mixing, not reactive transport. Both concentrations describe the same constituent." },
  noise: { fields: ["soundPowerDbA", "receptors[].distanceM or noiseContourLevelsDbA"], units: "dB(A) sound power re 1 pW; m", description: "Omnidirectional point-source spherical spreading in a free field. Optional chosen contour levels are display targets, not legal/health limits. No barriers, terrain or regulatory assessment." },
  cropYield: { fields: [], units: "unavailable", description: "Crop yield and forest mortality require calibrated response models. The existing agriculture job supplies climate-exposure indicators." }
} as const;
const ranges: Record<string, [number, number]> = { heatMw: [0, 100000], emissionRateGs: [0, 100000], withdrawalM3s: [0, 100000], returnM3s: [0, 100000], riverFlowM3s: [0, 1000000], upstreamTempC: [-2, 60], dischargeTempC: [-2, 100], upstreamMgL: [0, 1000000], dischargeMgL: [0, 1000000], soundPowerDbA: [0, 200] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
function sourceErrors(value: unknown, name: string): string[] {
  if (!object(value) || Object.keys(value).some(k => !["evidence", "citation", "url"].includes(k)) || !["reported", "assumed"].includes(String(value.evidence)) || typeof value.citation !== "string" || !value.citation.trim() || value.citation.length > 1000) return [`${name} requires reported/assumed evidence and a 1-1000 character citation`];
  if (value.url !== undefined) { try { const url = new URL(String(value.url)); if (typeof value.url !== "string" || value.url.length > 2000 || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return [`${name}.url must be HTTP(S), without credentials`]; } catch { return [`${name}.url must be a valid HTTP(S) source link`]; } }
  return [];
}
export function validateScreeningRequest(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== "1.0" || value.kind !== "environment-screening") errors.push("Expected schemaVersion 1.0 and kind environment-screening");
  if (Object.keys(value).some(k => !["schemaVersion", "kind", "siteId", "point", "years", "dispersion", "receptors", "noiseContourLevelsDbA", "backgroundNoise"].includes(k))) errors.push("Unknown screening request field");
  if ((value.siteId === undefined) === (value.point === undefined)) errors.push("Choose exactly one siteId or point");
  if (value.siteId !== undefined && !["ashburn", "colossus1", "colossus2", "abilene", "thedalles"].includes(String(value.siteId))) errors.push("Unknown study siteId");
  if (value.point !== undefined && (!object(value.point) || Object.keys(value.point).some(k => !["latitude", "longitude"].includes(k)) || !bounded(value.point.latitude, -90, 90) || !bounded(value.point.longitude, -180, 180))) errors.push("point requires finite WGS84 latitude/longitude");
  if (!Array.isArray(value.years) || !value.years.length || value.years.length > 81) errors.push("years requires 1-81 explicitly supplied annual records");
  else {
    const seen = new Set<number>();
    for (const row of value.years) {
      if (!object(row) || Object.keys(row).some(k => !["year", "source", "pollutant", ...Object.keys(ranges)].includes(k))) { errors.push("Unknown or invalid screening year field"); continue; }
      if (!Number.isInteger(row.year) || !bounded(row.year, 2020, 2100) || seen.has(Number(row.year))) errors.push("Screening years must be unique integers 2020-2100");
      seen.add(Number(row.year));
      const numeric = Object.keys(ranges).filter(k => row[k] !== undefined);
      for (const key of numeric) if (!bounded(row[key], ...ranges[key])) errors.push(`${key} must be finite in [${ranges[key].join(", ")}]`);
      if (numeric.length || row.source !== undefined) errors.push(...sourceErrors(row.source, `year ${row.year} source`));
      if (row.pollutant !== undefined && (typeof row.pollutant !== "string" || !row.pollutant.trim() || row.pollutant.length > 80)) errors.push("pollutant must identify the modeled constituent");
      if (typeof row.withdrawalM3s === "number" && typeof row.returnM3s === "number" && row.returnM3s > row.withdrawalM3s) errors.push("Returned flow cannot exceed withdrawal in the same accounting boundary");
    }
  }
  if (value.dispersion !== undefined) {
    const d = value.dispersion;
    if (!object(d) || Object.keys(d).some(k => !["effectiveHeightM", "landUse", "airDensityKgM3", "specificHeatJkgK", "source"].includes(k)) || !bounded(d.effectiveHeightM, 1, 300) || !["urban", "rural"].includes(String(d.landUse))) errors.push("dispersion requires effectiveHeightM 1-300 and urban/rural landUse");
    else { errors.push(...sourceErrors(d.source, "dispersion.source")); if (d.airDensityKgM3 !== undefined && !bounded(d.airDensityKgM3, .5, 2)) errors.push("airDensityKgM3 must be 0.5-2"); if (d.specificHeatJkgK !== undefined && !bounded(d.specificHeatJkgK, 800, 1200)) errors.push("specificHeatJkgK must be 800-1200"); }
  }
  if (value.receptors !== undefined && (!Array.isArray(value.receptors) || !value.receptors.length || value.receptors.length > 20 || value.receptors.some(r => !object(r) || Object.keys(r).some(k => !["name", "distanceM"].includes(k)) || typeof r.name !== "string" || !r.name.trim() || r.name.length > 80 || !bounded(r.distanceM, 1, 10000)))) errors.push("receptors must contain 1-20 named far-field distances from 1-10000 m");
  if (value.noiseContourLevelsDbA !== undefined && (!Array.isArray(value.noiseContourLevelsDbA) || !value.noiseContourLevelsDbA.length || value.noiseContourLevelsDbA.length > 5 || new Set(value.noiseContourLevelsDbA).size !== value.noiseContourLevelsDbA.length || value.noiseContourLevelsDbA.some(level => !bounded(level, 10, 140)))) errors.push("noiseContourLevelsDbA requires 1-5 unique chosen levels from 10-140 dB(A), not regulatory limits");
  if (value.backgroundNoise !== undefined) { const b = value.backgroundNoise; if (!object(b) || Object.keys(b).some(k => !["dbA", "source"].includes(k)) || !bounded(b.dbA, 0, 160)) errors.push("backgroundNoise needs dbA 0-160"); else errors.push(...sourceErrors(b.source, "backgroundNoise.source")); }
  return errors;
}
