import type { LandClimateResult, DailyMetric } from "./land-climate.ts";

export interface AgricultureSettings { growingMonths: number[]; baseTemperatureC: number; heatThresholdC: number; dryDayThresholdMm: number }
export const DEFAULT_AGRICULTURE_SETTINGS: AgricultureSettings = { growingMonths: [4, 5, 6, 7, 8, 9], baseTemperatureC: 10, heatThresholdC: 30, dryDayThresholdMm: 1 };
export function validateAgricultureSettings(value: AgricultureSettings): void {
  if (!Array.isArray(value.growingMonths) || !value.growingMonths.length || value.growingMonths.length > 12 || new Set(value.growingMonths).size !== value.growingMonths.length || value.growingMonths.some(month => !Number.isInteger(month) || month < 1 || month > 12)) throw new Error("growingMonths requires unique calendar months 1-12");
  if (!Number.isFinite(value.baseTemperatureC) || value.baseTemperatureC < -10 || value.baseTemperatureC > 40 || !Number.isFinite(value.heatThresholdC) || value.heatThresholdC <= value.baseTemperatureC || value.heatThresholdC > 60 || !Number.isFinite(value.dryDayThresholdMm) || value.dryDayThresholdMm < 0 || value.dryDayThresholdMm > 20) throw new Error("Invalid agricultural screening thresholds");
}
export function agricultureIndicators(data: LandClimateResult, settings: AgricultureSettings = DEFAULT_AGRICULTURE_SETTINGS) {
  validateAgricultureSettings(settings);
  return data.models.map(model => {
    const metrics = new Map(model.metrics.map(metric => [metric.id, metric]));
    const temperature = metrics.get("temperature_2m_mean");
    if (!temperature) throw new Error("Temperature is required for agricultural screening");
    const byYear = new Map<string, number[]>();
    temperature.series.forEach((item, index) => { if (settings.growingMonths.includes(Number(item.date.slice(5, 7)))) { const year = item.date.slice(0, 4); byYear.set(year, [...(byYear.get(year) ?? []), index]); } });
    const yearly = [...byYear].map(([year, indices]) => {
      const expectedDays = settings.growingMonths.reduce((sum, month) => sum + new Date(Date.UTC(Number(year), month, 0)).getUTCDate(), 0);
      const completeSeason = expectedDays === indices.length;
      function values(id: string): Array<number | null> { return indices.map(index => metrics.get(id)?.series[index]?.value ?? null); }
      function strict(id: string, aggregate: (values: number[]) => number): number | null { const selected = values(id); return completeSeason && selected.every(value => value !== null) ? aggregate(selected as number[]) : null; }
      const sums = (id: string) => strict(id, list => list.reduce((sum, value) => sum + value, 0));
      const rain = sums("precipitation_sum"); const et0 = sums("et0_fao_evapotranspiration");
      const soilId = metrics.has("soil_moisture_0_to_10cm_mean") ? "soil_moisture_0_to_10cm_mean" : "soil_moisture_0_to_7cm_mean";
      return { year: Number(year), expectedDays, returnedDays: indices.length, completeSeason, validDays: Object.fromEntries([...metrics].map(([id]) => [id, values(id).filter(value => value !== null).length])),
        meanTemperatureC: strict("temperature_2m_mean", list => list.reduce((a, b) => a + b, 0) / list.length),
        growingDegreeDaysCdays: strict("temperature_2m_mean", list => list.reduce((sum, value) => sum + Math.max(0, value - settings.baseTemperatureC), 0)),
        heatThresholdDays: strict("temperature_2m_max", list => list.filter(value => value > settings.heatThresholdC).length),
        frostDays: strict("temperature_2m_min", list => list.filter(value => value < 0).length),
        dryThresholdDays: strict("precipitation_sum", list => list.filter(value => value < settings.dryDayThresholdMm).length),
        precipitationMm: rain, referenceEvapotranspirationMm: et0, precipitationMinusReferenceEt0Mm: rain !== null && et0 !== null ? rain - et0 : null,
        meanSurfaceSoilMoisture: strict(soilId, list => list.reduce((a, b) => a + b, 0) / list.length), soilMoistureDepth: soilId.includes("10cm") ? "0-10 cm" : "0-7 cm", soilMoistureUnits: "m³/m³" };
    });
    return { model: model.model, yearly };
  });
}

export function compareAgriculture(baseline: LandClimateResult, future: LandClimateResult, settings: AgricultureSettings) {
  if (baseline.evidence !== "climate-scenario" || future.evidence !== "climate-scenario") throw new Error("Compare like-for-like climate simulations, not observed weather against a simulated future");
  const samePoint = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => a.latitude === b.latitude && a.longitude === b.longitude;
  if (baseline.sourceId !== future.sourceId || baseline.scenario !== future.scenario || baseline.timeStandard !== future.timeStandard || !samePoint(baseline.requestedPoint, future.requestedPoint) || !samePoint(baseline.sourcePoint, future.sourcePoint)) throw new Error("Agriculture comparison requires matching source, scenario, time standard and locations");
  const definition = (data: LandClimateResult) => data.models.map(model => ({ model: model.model, metrics: model.metrics.map(metric => `${metric.id}:${metric.units}`).sort() })).sort((a, b) => a.model.localeCompare(b.model));
  if (new Set(baseline.models.map(model => model.model)).size !== baseline.models.length || JSON.stringify(definition(baseline)) !== JSON.stringify(definition(future))) throw new Error("Agriculture comparison requires identical model sets, variable definitions and units/depths");
  const before = agricultureIndicators(baseline, settings); const after = agricultureIndicators(future, settings);
  const fields = ["meanTemperatureC", "growingDegreeDaysCdays", "heatThresholdDays", "frostDays", "dryThresholdDays", "precipitationMm", "referenceEvapotranspirationMm", "precipitationMinusReferenceEt0Mm", "meanSurfaceSoilMoisture"] as const;
  const comparisons = before.map(model => {
    const next = after.find(value => value.model === model.model);
    if (!next) throw new Error("Baseline and future models must match");
    const indicators = Object.fromEntries(fields.map(field => {
      const first = model.yearly.map(year => year[field]); const last = next.yearly.map(year => year[field]);
      const mean = (list: Array<number | null>) => list.length && list.every(value => value !== null) ? (list as number[]).reduce((a, b) => a + b, 0) / list.length : null;
      const base = mean(first), projected = mean(last);
      return [field, { baselineMeanPerSeason: base, futureMeanPerSeason: projected, change: base !== null && projected !== null ? projected - base : null }];
    }));
    return { model: model.model, baselineSeasons: model.yearly.length, futureSeasons: next.yearly.length, indicators };
  });
  return { schemaVersion: "1.0", kind: "agriculture", evidence: "conditional-climate-screening", settings, baselinePeriod: baseline.period, futurePeriod: future.period, comparisons,
    baseline: before, future: after,
    unavailable: [ { metric: "crop_yield_prediction", reason: "No calibrated crop-growth model, crop identity/phenology, soil profile, management and observed-yield validation are integrated." }, { metric: "data_center_attributable_crop_effect", reason: "Regional climate scenarios do not isolate facility emissions, withdrawals, noise or land-use effects." }, { metric: "pollution_crop_damage", reason: "Pollutant dose, deposition and crop-specific exposure-response models are required." } ],
    warnings: ["These are climate-exposure indicators, not predicted crop yields or an agricultural suitability rating.", "Thresholds are user-selected screening assumptions, not universal crop limits; choose months and thresholds appropriate to the investigation.", "Calendar-year season grouping does not model crop phenology or cross-year crop cycles.", "Indicators require complete selected-month seasons and complete values; missing data produces null, not zero or a partial-season total.", "Periods shorter than 30 years can be strongly affected by natural variability; no statistical significance or probabilistic confidence is implied.", "Precipitation minus reference ET0 is not a prediction of irrigation demand or water scarcity."], sources: [ { sourceUrl: baseline.sourceUrl, retrievedAt: baseline.retrievedAt, rawSha256: baseline.rawSha256 }, { sourceUrl: future.sourceUrl, retrievedAt: future.retrievedAt, rawSha256: future.rawSha256 } ] };
}
