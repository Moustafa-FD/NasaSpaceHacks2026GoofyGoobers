// Descriptive summaries of supplied observations. No facility attribution or forecasts.
export const STORY_VARIABLES = Object.freeze({
  NO2_OMI: { group: 'air', label: 'Air · long record', short: 'NO₂ column', unit: '×10¹⁵ molecules/cm²', digits: 2, higher: 'adverse', source: 'NASA OMI · about 13 × 24 km', meaning: 'Nitrogen dioxide through a column of air. This is not breathing-height pollution.', favorable: 'Lower NO₂ signal', adverse: 'Higher NO₂ signal' },
  NO2: { group: 'air', label: 'Air · recent detail', short: 'NO₂ column', unit: '×10¹⁵ molecules/cm²', digits: 2, higher: 'adverse', source: 'Sentinel-5P TROPOMI · about 5 km · since September 2023', meaning: 'A more detailed but shorter satellite record of nitrogen dioxide. It is not a street-level exposure reading.', favorable: 'Lower NO₂ signal', adverse: 'Higher NO₂ signal' },
  AOD: { group: 'air', label: 'Air · particles', short: 'Aerosol optical depth', unit: 'AOD', digits: 3, higher: 'adverse', source: 'MODIS · about 3 km', meaning: 'How much sunlight airborne particles block. It is not a measured PM₂.₅ concentration.', favorable: 'Lower particle signal', adverse: 'Higher particle signal' },
  NDVI: { group: 'vegetation', label: 'Vegetation', short: 'Greenness', unit: 'NDVI', digits: 3, higher: 'favorable', source: 'MODIS · about 250 m', meaning: 'Satellite greenness. Greener does not by itself prove healthier plants, biodiversity or crop yield.', favorable: 'Greener relative to nearby', adverse: 'Less green relative to nearby' },
  LST_Day: { group: 'heat', label: 'Heat · daytime', short: 'Surface temperature', unit: '°C', digits: 1, higher: 'adverse', source: 'MODIS · about 1 km · daytime surface', meaning: 'The temperature of ground and roofs, not the air.', favorable: 'Cooler relative to nearby', adverse: 'Warmer relative to nearby' },
  LST_Night: { group: 'heat', label: 'Heat · nighttime', short: 'Night surface temperature', unit: '°C', digits: 1, higher: 'adverse', source: 'MODIS · about 1 km · nighttime surface', meaning: 'The temperature of ground and roofs after sunset, not the air.', favorable: 'Cooler relative to nearby', adverse: 'Warmer relative to nearby' },
  AirTemp: { group: 'heat', label: 'Regional air temperature', short: 'Regional air temperature', unit: '°C', digits: 1, higher: 'adverse', regional: true, source: 'NASA MERRA-2 · about 50 km', meaning: 'Regional air temperature helps explain weather and climate around the site. Its grid cannot resolve a building.', favorable: 'Lower regional temperature', adverse: 'Higher regional temperature' },
});
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (items) => items.length ? items.reduce((sum, v) => sum + v, 0) / items.length : null;
export const storyFormat = (value, digits = 1, sign = false) => {
  if(!finite(value))return 'Unknown';
  const magnitude=Math.abs(value),precision=magnitude>0&&magnitude<10**-digits?Math.min(4,Math.max(digits,Math.ceil(-Math.log10(magnitude)))):digits;
  if(magnitude>0&&magnitude<.0001)return value<0?'>−0.0001':`${sign?'+':''}<0.0001`;
  return `${sign&&value>0?'+':''}${value.toLocaleString('en-US',{maximumFractionDigits:precision})}`;
};

/** One value per year, with a conservative 9/12-month minimum. Pair comparisons
 * use the same observed months at the site and nearby region, never null→zero. */
export function annualStorySeries(series, minMonths = 9) {
  if (!Array.isArray(series?.t)) return [];
  const years = new Map();
  series.t.forEach((date, i) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) return;
    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
    if (!years.has(year)) years.set(year, new Map());
    years.get(year).set(month, { site: series.site?.[i], ref: series.ref?.[i] });
  });
  return [...years].sort(([a], [b]) => a - b).map(([year, months]) => {
    const rows = [...months.values()], site = rows.filter((r) => finite(r.site)).map((r) => r.site), ref = rows.filter((r) => finite(r.ref)).map((r) => r.ref), paired = rows.filter((r) => finite(r.site) && finite(r.ref));
    return { year, site: site.length >= minMonths ? mean(site) : null, ref: ref.length >= minMonths ? mean(ref) : null,
      pairedSite: paired.length >= minMonths ? mean(paired.map((r) => r.site)) : null, pairedRef: paired.length >= minMonths ? mean(paired.map((r) => r.ref)) : null,
      local: paired.length >= minMonths ? mean(paired.map((r) => r.site - r.ref)) : null,
      siteMonths: site.length, refMonths: ref.length, pairedMonths: paired.length, complete: paired.length === 12 };
  });
}

export function storyBaseline(annual, onset) {
  const onsetYear = typeof onset === 'string' && /^\d{4}-\d{2}/.test(onset) ? Number(onset.slice(0, 4)) : null;
  if (!onsetYear) return { available: false, years: [], reason: 'No sourced comparison-start date is available for this location.' };
  // Full calendar years only: the construction/start year never enters baseline.
  const rows = annual.filter((p) => p.year >= onsetYear - 5 && p.year < onsetYear && finite(p.local));
  if (!rows.length) return { available: false, years: [], start: onsetYear - 5, end: onsetYear - 1, reason: 'No pre-start year has at least 9 months at both the site and nearby region.' };
  return { available: true, years: rows.map((p) => p.year), start: rows[0].year, end: rows.at(-1).year, site: mean(rows.map((p) => p.pairedSite)), ref: mean(rows.map((p) => p.pairedRef)), local: mean(rows.map((p) => p.local)), partial: rows.length < 5 || rows.some((p) => !p.complete) };
}

function comparison(point, baseline, regional) {
  if (!point || !baseline.available || !finite(point.local)) return null;
  return { site: point.pairedSite - baseline.site, nearby: point.pairedRef - baseline.ref, local: regional ? point.pairedSite - baseline.site : point.local - baseline.local };
}

export function summarizeStoryMetric(series, site, variable, year, analysis) {
  const meta = STORY_VARIABLES[variable] || STORY_VARIABLES.LST_Day, annual = annualStorySeries(series), baseline = storyBaseline(annual, site?.onset);
  const actual = annual.filter((p) => p.siteMonths > 0 || p.refMonths > 0), lastYear = actual.at(-1)?.year;
  const future = (lastYear != null && year > lastYear) || year > new Date().getUTCFullYear(), selected = annual.find((p) => p.year === year) || null;
  const window = [year - 2, year - 1, year].map((y) => annual.find((p) => p.year === y));
  const completeWindow = !future && window.every((p) => p && finite(p.local));
  const trailing = completeWindow ? { start: year - 2, end: year, years: window.map((p) => p.year), pairedSite: mean(window.map((p) => p.pairedSite)), pairedRef: mean(window.map((p) => p.pairedRef)), local: mean(window.map((p) => p.local)), partial: window.some((p) => !p.complete) } : null;
  const change = comparison(trailing, baseline, meta.regional), selectedChange = future ? null : comparison(selected, baseline, meta.regional);
  let status = 'uncertain', direction = 'Not enough evidence';
  if (change && Math.abs(change.local) > 1e-12) { status = change.local > 0 ? meta.higher : meta.higher === 'adverse' ? 'favorable' : 'adverse'; direction = meta[status]; }
  else if (change) direction = 'Little relative change';
  if (future) direction = 'No annual site forecast';
  if (baseline.available && baseline.years.length < 2) status = 'uncertain';
  const trend = meta.regional ? analysis?.trendSite : analysis?.trendDiff;
  const significance = trend && trend.n >= 4 && finite(trend.p) && finite(trend.slope) ? { significant: trend.p < .05, p: trend.p, slopePerDecade: trend.slope * 10, years: trend.n, start: analysis.first?.slice(0, 4), end: analysis.last?.slice(0, 4) } : null;
  return { variable, meta, year, onsetYear: /^\d{4}-\d{2}/.test(site?.onset || '') ? Number(site.onset.slice(0, 4)) : null, annual, baseline, selected: future ? null : selected, trailing, change, selectedChange, future, lastYear, status, direction, significance,
    coverage: future ? `The source record ends in ${lastYear}; ${year} has no observed annual value.` : !selected ? `No source samples for ${year}.` : `${selected.siteMonths}/12 site months; ${selected.refMonths}/12 nearby months; ${selected.pairedMonths}/12 matching months. At least 9 are required.`,
    uncertainty: !baseline.available ? baseline.reason : !trailing ? `A trailing 3-year summary needs 9 matching months in each of ${year - 2}, ${year - 1} and ${year}. Missing years are not filled.` : baseline.years.length < 2 ? 'Only one pre-start baseline year is available; this descriptive comparison is fragile.' : 'These differences describe observations; they do not identify the cause.' };
}

export function resolveStoryVariables(vars = {}, active) {
  return { air: STORY_VARIABLES[active]?.group === 'air' ? active : vars.NO2_OMI ? 'NO2_OMI' : 'NO2', vegetation: 'NDVI', heat: STORY_VARIABLES[active]?.group === 'heat' ? active : 'LST_Day' };
}

/** Only actual loaded records in the selected year enter water summaries. Soil
 * moisture is not relabelled groundwater; no station-to-river interpolation. */
export function summarizeStoryWater(results = [], year) {
  const output = { soil: null, rain: null, station: null, groundwater: null, year };
  for (const result of results) {
    if (result?.kind === 'land-water') for (const model of result.models || []) for (const metric of model.metrics || []) {
      const rows = (metric.series || []).filter((p) => String(p.date).slice(0, 4) === String(year) && finite(p.value));
      if (!rows.length) continue;
      if (/^soil_moisture_(0_to_7cm|0_to_10cm)/.test(metric.id)) output.soil = { value: mean(rows.map((p) => p.value)), unit: metric.units, days: rows.length, id: metric.id, evidence: result.evidence, sourceUrl: result.sourceUrl };
      if (metric.id === 'precipitation_sum') output.rain = { value: mean(rows.map((p) => p.value)), unit: metric.units ? `${metric.units}/day` : 'unit not supplied', days: rows.length, evidence: result.evidence, sourceUrl: result.sourceUrl };
    }
    if (result?.kind === 'water-quality') {
      const rows = (result.records || []).filter((r) => String(r.sourceTime || r.date).slice(0, 4) === String(year));
      if (rows.length) output.station = { id: result.station?.id, name: result.station?.name, numeric: rows.filter((r) => r.valueStatus === 'numeric' && finite(r.value)).length, count: rows.length, evidence: result.evidence, sourceUrl: result.station?.sourceUrl };
    }
  }
  return output;
}
