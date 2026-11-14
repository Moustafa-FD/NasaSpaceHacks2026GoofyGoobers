import test from "node:test";
import assert from "node:assert/strict";
import { agricultureIndicators, compareAgriculture, validateAgricultureSettings, type AgricultureSettings } from "../apps/api/src/environment/agriculture.ts";
import { dayRange, type LandClimateResult } from "../apps/api/src/environment/land-climate.ts";

const settings: AgricultureSettings = { growingMonths: [1], baseTemperatureC: 10, heatThresholdC: 30, dryDayThresholdMm: 1 };
const values: Record<string, { units: string; value: number }> = {
  temperature_2m_mean: { units: "°C", value: 10 }, temperature_2m_max: { units: "°C", value: 30 }, temperature_2m_min: { units: "°C", value: 0 },
  precipitation_sum: { units: "mm", value: 1 }, et0_fao_evapotranspiration: { units: "mm", value: 2 }, soil_moisture_0_to_10cm_mean: { units: "m³/m³", value: 0.2 },
};

/** Synthetic complete daily series used only to verify indicator arithmetic. */
function source(start = "2030-01-01", end = "2030-01-31", modelIds = ["EC_Earth3P_HR"]): LandClimateResult {
  const dates = dayRange(start, end);
  return { schemaVersion: "1.0", sourceId: "open-meteo-highresmip", sourceUrl: `https://climate-api.open-meteo.com/v1/climate?start_date=${start}&end_date=${end}`,
    documentationUrl: "https://open-meteo.com/en/docs/climate-api", retrievedAt: "2026-11-14T12:00:00Z", evidence: "climate-scenario", timeStandard: "UTC",
    requestedPoint: { latitude: 43.65, longitude: -79.38 }, sourcePoint: { latitude: 43.6, longitude: -79.4 }, period: { start, end },
    models: modelIds.map(model => ({ model, metrics: Object.entries(values).map(([id, item]) => ({ id, sourceVariable: id, units: item.units,
      series: dates.map(date => ({ date, value: item.value })), validDays: dates.length, missingDays: 0 })) })),
    spatialResolution: "Synthetic fixture", scenario: "Synthetic fixed climate scenario", license: {}, warnings: [], raw: { synthetic: true }, rawSha256: "a".repeat(64) };
}
function change(data: LandClimateResult, id: string, fn: (value: number | null, index: number, date: string) => number | null, model = 0) {
  const metric = data.models[model].metrics.find(item => item.id === id)!;
  metric.series = metric.series.map((item, index) => ({ date: item.date, value: fn(item.value, index, item.date) }));
  metric.validDays = metric.series.filter(item => item.value !== null).length; metric.missingDays = metric.series.length - metric.validDays;
}

test("agricultural screening computes GDD, strict heat/frost/dry thresholds and rain minus reference ET0", () => {
  const data = source();
  change(data, "temperature_2m_mean", (value, i) => [5, 10, 15, 20, 25][i] ?? value);
  change(data, "temperature_2m_max", (value, i) => [30, 31, 35, 29, 30][i] ?? value);
  change(data, "temperature_2m_min", (value, i) => [-1, 0, 1, -5, 0][i] ?? value);
  change(data, "precipitation_sum", (value, i) => [0, 0.5, 1, 2, 3][i] ?? value);
  change(data, "soil_moisture_0_to_10cm_mean", (value, i) => i === 0 ? 0 : value);
  const year = agricultureIndicators(data, settings)[0].yearly[0];
  assert.equal(year.completeSeason, true); assert.equal(year.expectedDays, 31); assert.equal(year.returnedDays, 31);
  assert.ok(Math.abs(year.meanTemperatureC! - 335 / 31) < 1e-12);
  assert.equal(year.growingDegreeDaysCdays, 30);
  assert.equal(year.heatThresholdDays, 2); assert.equal(year.frostDays, 2); assert.equal(year.dryThresholdDays, 2);
  assert.equal(year.precipitationMm, 32.5); assert.equal(year.referenceEvapotranspirationMm, 62); assert.equal(year.precipitationMinusReferenceEt0Mm, -29.5);
  assert.ok(Math.abs(year.meanSurfaceSoilMoisture! - 6 / 31) < 1e-12);
  assert.equal(year.soilMoistureDepth, "0-10 cm"); assert.equal(year.soilMoistureUnits, "m³/m³");
});

test("zero-valued indicators remain zero and depth follows the source metric", () => {
  const data = source();
  const soil = data.models[0].metrics.find(item => item.id === "soil_moisture_0_to_10cm_mean")!;
  soil.id = "soil_moisture_0_to_7cm_mean"; soil.sourceVariable = soil.id;
  change(data, soil.id, () => 0);
  const year = agricultureIndicators(data, settings)[0].yearly[0];
  for (const field of ["growingDegreeDaysCdays", "heatThresholdDays", "frostDays", "dryThresholdDays", "meanSurfaceSoilMoisture"] as const) assert.equal(year[field], 0);
  assert.equal(year.soilMoistureDepth, "0-7 cm"); assert.equal(year.precipitationMinusReferenceEt0Mm, -31);
});

test("missing values null only affected indicators, with coverage counts preserved", () => {
  const data = source();
  change(data, "temperature_2m_mean", (value, i) => i === 0 ? null : value);
  change(data, "precipitation_sum", (value, i) => i === 5 ? null : value);
  change(data, "soil_moisture_0_to_10cm_mean", (value, i) => i === 7 ? null : value);
  const year = agricultureIndicators(data, settings)[0].yearly[0];
  assert.equal(year.completeSeason, true); assert.equal(year.validDays.precipitation_sum, 30);
  for (const field of ["meanTemperatureC", "growingDegreeDaysCdays", "precipitationMm", "dryThresholdDays", "precipitationMinusReferenceEt0Mm", "meanSurfaceSoilMoisture"] as const) assert.equal(year[field], null);
  assert.equal(year.referenceEvapotranspirationMm, 62); assert.equal(year.heatThresholdDays, 0); assert.equal(year.frostDays, 0);
});

test("an entirely missing metric produces null rather than an apparent zero impact", () => {
  const data = source();
  for (const id of Object.keys(values)) change(data, id, () => null);
  const year = agricultureIndicators(data, settings)[0].yearly[0];
  assert.equal(year.validDays.temperature_2m_mean, 0);
  for (const field of ["meanTemperatureC", "growingDegreeDaysCdays", "heatThresholdDays", "frostDays", "dryThresholdDays", "precipitationMm", "referenceEvapotranspirationMm", "precipitationMinusReferenceEt0Mm", "meanSurfaceSoilMoisture"] as const) assert.equal(year[field], null);
});

test("partial selected-month seasons never become full-season totals, including leap and cross-year seasons", () => {
  const partial = agricultureIndicators(source("2030-01-01", "2030-01-10"), settings)[0].yearly[0];
  assert.equal(partial.expectedDays, 31); assert.equal(partial.returnedDays, 10); assert.equal(partial.completeSeason, false);
  assert.equal(partial.precipitationMm, null); assert.equal(partial.growingDegreeDaysCdays, null); assert.equal(partial.heatThresholdDays, null);
  const leap = agricultureIndicators(source("2024-02-01", "2024-02-29"), { ...settings, growingMonths: [2] })[0].yearly[0];
  assert.equal(leap.expectedDays, 29); assert.equal(leap.completeSeason, true); assert.equal(leap.precipitationMm, 29);
  const leapMissing = agricultureIndicators(source("2024-02-01", "2024-02-28"), { ...settings, growingMonths: [2] })[0].yearly[0];
  assert.equal(leapMissing.completeSeason, false); assert.equal(leapMissing.precipitationMm, null);
  const crossYear = agricultureIndicators(source("2030-12-01", "2031-01-31"), { ...settings, growingMonths: [12, 1] })[0].yearly;
  assert.equal(crossYear.length, 2); assert.ok(crossYear.every(year => !year.completeSeason && year.precipitationMm === null));
});

test("baseline/future comparison uses mean per complete season and keeps model results separate", () => {
  const baseline = source("2000-01-01", "2001-12-31", ["EC_Earth3P_HR", "MRI_AGCM3_2_S"]);
  const future = source("2040-01-01", "2040-12-31", ["MRI_AGCM3_2_S", "EC_Earth3P_HR"]);
  change(future, "temperature_2m_mean", () => 14, 0); change(future, "temperature_2m_mean", () => 12, 1);
  const result = compareAgriculture(baseline, future, settings);
  const ec = result.comparisons.find(model => model.model === "EC_Earth3P_HR")!;
  const mri = result.comparisons.find(model => model.model === "MRI_AGCM3_2_S")!;
  assert.equal(ec.baselineSeasons, 2); assert.equal(ec.futureSeasons, 1);
  assert.deepEqual(ec.indicators.meanTemperatureC, { baselineMeanPerSeason: 10, futureMeanPerSeason: 12, change: 2 });
  assert.equal(ec.indicators.growingDegreeDaysCdays.change, 62); assert.equal(mri.indicators.growingDegreeDaysCdays.change, 124);
  assert.deepEqual(ec.indicators.precipitationMm, { baselineMeanPerSeason: 31, futureMeanPerSeason: 31, change: 0 });
  assert.equal(result.evidence, "conditional-climate-screening");
  assert.ok(result.unavailable.some(item => item.metric === "crop_yield_prediction"));
  assert.ok(result.unavailable.some(item => item.metric === "data_center_attributable_crop_effect"));
  assert.equal(result.sources[0].rawSha256, baseline.rawSha256);
  assert.ok(result.warnings.some(value => value.includes("not predicted crop yields")));
});

test("one incomplete baseline season keeps aggregate changes null", () => {
  const baseline = source("2000-01-01", "2001-01-10"); const future = source("2040-01-01", "2040-12-31");
  const model = compareAgriculture(baseline, future, settings).comparisons[0];
  assert.equal(model.baselineSeasons, 2); assert.equal(model.indicators.precipitationMm.baselineMeanPerSeason, null);
  assert.equal(model.indicators.precipitationMm.futureMeanPerSeason, 31); assert.equal(model.indicators.precipitationMm.change, null);
});

test("comparison rejects unlike evidence, locations, scenarios, model sets and units/depth definitions", () => {
  const baseline = source("2000-01-01", "2000-12-31");
  const mutations: Array<(data: LandClimateResult) => void> = [
    data => { data.evidence = "model-derived"; }, data => { data.sourceId = "different-source"; }, data => { data.scenario = "different-forcing"; },
    data => { data.requestedPoint.latitude += 1; }, data => { data.sourcePoint.longitude += 1; }, data => { data.timeStandard = "local" as "UTC"; },
    data => { data.models[0].model = "different-model"; }, data => { data.models.push(structuredClone(data.models[0])); },
    data => { data.models.push({ ...structuredClone(data.models[0]), model: "MRI_AGCM3_2_S" }); },
    data => { data.models[0].metrics[0].units = "°F"; }, data => { data.models[0].metrics.at(-1)!.id = "soil_moisture_0_to_7cm_mean"; },
    data => { data.models[0].metrics.pop(); },
  ];
  for (const mutation of mutations) {
    const future = source("2040-01-01", "2040-12-31"); mutation(future);
    assert.throws(() => compareAgriculture(baseline, future, settings), /like-for-like|matching|identical/);
  }
});

test("screening requires explicit valid month/temperature/rainfall thresholds", () => {
  assert.doesNotThrow(() => validateAgricultureSettings(settings));
  for (const invalid of [{ ...settings, growingMonths: [] }, { ...settings, growingMonths: [1, 1] }, { ...settings, growingMonths: [0] }, { ...settings, growingMonths: [13] },
    { ...settings, baseTemperatureC: NaN }, { ...settings, heatThresholdC: 10 }, { ...settings, heatThresholdC: 61 }, { ...settings, dryDayThresholdMm: -1 }]) assert.throws(() => validateAgricultureSettings(invalid));
  const noTemperature = source(); noTemperature.models[0].metrics = noTemperature.models[0].metrics.filter(metric => metric.id !== "temperature_2m_mean");
  assert.throws(() => agricultureIndicators(noTemperature, settings), /Temperature is required/);
});
