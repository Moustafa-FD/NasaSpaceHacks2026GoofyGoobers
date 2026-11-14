import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { ResultManifest, Scenario } from "../../../packages/contracts/src/index.ts";

const ajv = new Ajv({ allErrors: true, strict: true });
const scenarioSchema = JSON.parse(readFileSync(new URL("../../../packages/contracts/schemas/scenario.schema.json", import.meta.url), "utf8"));
const resultSchema = JSON.parse(readFileSync(new URL("../../../packages/contracts/schemas/result.schema.json", import.meta.url), "utf8"));
ajv.addSchema(scenarioSchema);
const validateScenario = ajv.getSchema<Scenario>(scenarioSchema.$id)!;
const validateResult = ajv.compile<ResultManifest>(resultSchema);

export function scenarioErrors(input: unknown): string[] {
  if (!validateScenario(input)) return (validateScenario.errors ?? []).map(error => `${error.instancePath || "/"} ${error.message}`);
  const scenario = input as Scenario;
  const errors: string[] = [];
  if (scenario.years.end < scenario.years.start || scenario.years.end - scenario.years.start > 80) errors.push("years must be ordered and span at most 80 years");
  const [west, south, east, north] = scenario.region.bbox;
  if (west >= east || south >= north) errors.push("bbox requires west < east and south < north; dateline crossing is not supported");
  return errors;
}

export function assertResult(input: unknown, runId: string, scenario: Scenario): asserts input is ResultManifest {
  if (!validateResult(input)) throw new Error(`Worker result contract mismatch: ${ajv.errorsText(validateResult.errors)}`);
  if (input.runId !== runId || input.scenarioName !== scenario.name) throw new Error("Worker returned the wrong run or scenario");
  if (!isDeepStrictEqual(input.region, scenario.region) || !isDeepStrictEqual(input.years, scenario.years)) throw new Error("Worker result geography or years differ from request");
  if (!isDeepStrictEqual(input.provenance.assumptions, scenario.assumptions)) throw new Error("Worker result assumptions differ from request");
  const ids = new Set<string>();
  for (const metric of input.metrics) {
    if (ids.has(metric.id)) throw new Error("Duplicate metric ID");
    ids.add(metric.id);
    const expectedLength = scenario.years.end - scenario.years.start + 1;
    if (metric.series.length !== expectedLength || metric.series.some((point, i) => point.year !== scenario.years.start + i || !Number.isFinite(point.value))) throw new Error("Worker returned incomplete or non-finite time series");
  }
}
