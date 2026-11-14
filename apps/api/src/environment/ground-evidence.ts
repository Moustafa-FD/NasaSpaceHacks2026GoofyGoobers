/** Validate user-supplied evidence without contacting or verifying its source. */
export const GROUND_EVIDENCE_DOMAINS = ["water-quality", "noise", "agriculture", "vegetation"] as const;
export type GroundEvidenceDomain = typeof GROUND_EVIDENCE_DOMAINS[number];
export const GROUND_NOISE_VARIABLES = ["LAeq", "Lden", "Lnight", "LAmax", "LCpeak"] as const;

export interface GroundEvidenceRecord {
  domain: GroundEvidenceDomain;
  variable: string;
  unit: string;
  value: number | null;
  /** Explicit ISO 8601 UTC timestamp, including seconds and a Z suffix. */
  date: string;
  point: { latitude: number; longitude: number };
  stationId: string;
  /** User assertion only; no facility matching or causal attribution occurs. */
  facilityId?: string;
  /** Required for LAeq; retained without acoustic aggregation or conversion. */
  durationSeconds?: number;
  /** Lden/Lnight source-period/weighting definition; not independently verified. */
  period?: string;
  /** Water-quality censoring/qualifier labels, preserved without substitution. */
  qualifiers?: string[];
  detectionLimit?: number;
  provenance: {
    sourceUrl: string;
    recordId: string;
    method: "measured" | "reported" | "estimated";
    qualityFlag?: string;
    notes?: string;
  };
}

export interface GroundEvidenceRequest {
  schemaVersion: "1.0";
  kind: "ground-evidence";
  records: GroundEvidenceRecord[];
}

export interface GroundEvidenceResult {
  schemaVersion: "1.0";
  kind: "ground-evidence";
  sourceId: "user-supplied-ground-evidence";
  importedAt: string;
  evidence: "user-supplied";
  verification: { status: "not_independently_verified"; method: "structural_validation_only" };
  recordCount: number;
  records: GroundEvidenceRecord[];
  warnings: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function utcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  // Date.parse can roll an impossible calendar date forward into another month.
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  return new Date(time).toISOString() === canonical;
}

function httpsReference(value: unknown): value is string {
  if (!text(value, 2048) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) errors.push(`${path} has unknown fields: ${unexpected.join(", ")}`);
}

function optionalText(value: Record<string, unknown>, key: string, maximum: number, path: string, errors: string[]): void {
  if (Object.hasOwn(value, key) && !text(value[key], maximum)) errors.push(`${path}.${key} must be a nonblank string of at most ${maximum} characters`);
}

/** Returns structural errors only; a valid import is not verified evidence. */
export function validateGroundEvidence(input: unknown): string[] {
  const errors: string[] = [];
  const request = object(input);
  if (!request) return ["Ground evidence body must be an object"];
  unknownFields(request, ["schemaVersion", "kind", "records"], "request", errors);
  if (request.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (request.kind !== "ground-evidence") errors.push("kind must be ground-evidence");
  if (!Array.isArray(request.records) || request.records.length < 1 || request.records.length > 100) {
    errors.push("records must contain 1-100 source records");
    return errors;
  }
  Array.from(request.records).forEach((candidate, index) => {
    const path = `records[${index}]`;
    const record = object(candidate);
    if (!record) { errors.push(`${path} must be an object`); return; }
    unknownFields(record, ["domain", "variable", "unit", "value", "date", "point", "stationId", "facilityId", "durationSeconds", "period", "qualifiers", "detectionLimit", "provenance"], path, errors);
    if (!GROUND_EVIDENCE_DOMAINS.includes(record.domain as GroundEvidenceDomain)) errors.push(`${path}.domain must be water-quality, noise, agriculture or vegetation`);
    if (!text(record.variable, 120)) errors.push(`${path}.variable must be a nonblank string of at most 120 characters`);
    if (!text(record.unit, 80)) errors.push(`${path}.unit must be a nonblank string of at most 80 characters`);
    if (record.value !== null && (typeof record.value !== "number" || !Number.isFinite(record.value))) errors.push(`${path}.value must be a finite number or null`);
    if (!utcDate(record.date)) errors.push(`${path}.date must be a real ISO 8601 UTC date with seconds and a Z suffix`);
    if (!text(record.stationId, 160)) errors.push(`${path}.stationId must be a nonblank string of at most 160 characters`);
    optionalText(record, "facilityId", 160, path, errors);
    const point = object(record.point);
    if (!point) errors.push(`${path}.point must be an object`);
    else {
      unknownFields(point, ["latitude", "longitude"], `${path}.point`, errors);
      if (typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) errors.push(`${path}.point requires finite latitude [-90,90] and longitude [-180,180]`);
    }
    const provenance = object(record.provenance);
    if (!provenance) errors.push(`${path}.provenance must be an object`);
    else {
      unknownFields(provenance, ["sourceUrl", "recordId", "method", "qualityFlag", "notes"], `${path}.provenance`, errors);
      if (!httpsReference(provenance.sourceUrl)) errors.push(`${path}.provenance.sourceUrl must be an HTTPS reference without embedded credentials, at most 2048 characters`);
      if (!text(provenance.recordId, 200)) errors.push(`${path}.provenance.recordId must be a nonblank string of at most 200 characters`);
      if (typeof provenance.method !== "string" || !["measured", "reported", "estimated"].includes(provenance.method)) errors.push(`${path}.provenance.method must be measured, reported or estimated`);
      optionalText(provenance, "qualityFlag", 120, `${path}.provenance`, errors);
      optionalText(provenance, "notes", 1000, `${path}.provenance`, errors);
    }

    if (record.domain === "noise") {
      if (!GROUND_NOISE_VARIABLES.includes(record.variable as typeof GROUND_NOISE_VARIABLES[number])) errors.push(`${path}.variable must be one of ${GROUND_NOISE_VARIABLES.join(", ")} for noise`);
      if (record.variable === "LAeq" && !Object.hasOwn(record, "durationSeconds")) errors.push(`${path}.durationSeconds is required for LAeq`);
      if (Object.hasOwn(record, "durationSeconds") && (typeof record.durationSeconds !== "number" || !Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0 || record.durationSeconds > 31_622_400)) errors.push(`${path}.durationSeconds must be finite, positive and no more than 366 days`);
      if ((record.variable === "Lden" || record.variable === "Lnight") && !Object.hasOwn(record, "period")) errors.push(`${path}.period must document the Lden/Lnight source period and applicable weighting`);
      optionalText(record, "period", 500, path, errors);
    } else {
      if (Object.hasOwn(record, "durationSeconds") || Object.hasOwn(record, "period")) errors.push(`${path}.durationSeconds and period are noise-only metadata`);
    }
    if (record.domain === "water-quality") {
      if (Object.hasOwn(record, "qualifiers") && (!Array.isArray(record.qualifiers) || record.qualifiers.length < 1 || record.qualifiers.length > 10 || Array.from(record.qualifiers).some(item => !text(item, 120)))) errors.push(`${path}.qualifiers must contain 1-10 nonblank labels of at most 120 characters`);
      if (Object.hasOwn(record, "detectionLimit") && (typeof record.detectionLimit !== "number" || !Number.isFinite(record.detectionLimit) || record.detectionLimit < 0)) errors.push(`${path}.detectionLimit must be a finite nonnegative number in the record's supplied unit`);
    } else if (Object.hasOwn(record, "qualifiers") || Object.hasOwn(record, "detectionLimit")) errors.push(`${path}.qualifiers and detectionLimit are water-quality-only metadata`);
  });
  return errors;
}

/** Retains each source record independently; no URL fetch, unit conversion or averaging. */
export function normalizeGroundEvidence(input: unknown, now: Date = new Date()): GroundEvidenceResult {
  const errors = validateGroundEvidence(input);
  if (errors.length) throw new Error(`Ground evidence validation failed: ${errors.join("; ")}`);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Ground evidence import clock is invalid");
  const request = input as GroundEvidenceRequest;
  const records = structuredClone(request.records);
  const warnings = [
    "These records are user-supplied and have not been independently verified. Validation checks structure and finite values, not the truth, calibration, representativeness, license or scientific quality of a measurement.",
    "Source URLs are retained as references and are never fetched by this import. Provenance methods and quality flags are the submitter's claims, not source verification.",
    "Records, nulls, zeroes, units and source qualifiers are retained separately without unit conversion, aggregation, interpolation or missing-value substitution.",
    "Station and facility IDs are user assertions; no facility matching, source attribution or data-center causation is inferred.",
    "An imported record does not implement a trend model, forecast or future environmental-impact prediction."
  ];
  if (records.some(record => record.domain === "noise")) warnings.push("Noise metrics and averaging/weighted periods remain separate source records. No arithmetic averaging of decibels, acoustic conversion or compliance determination is performed; Lden/Lnight period definitions and LAeq durations are not independently verified.");
  if (records.some(record => record.domain === "water-quality")) warnings.push("Water-quality censoring, detection limits and source quality flags remain attached to their values. A censored result is not converted to zero, half its detection limit or a confirmed exact concentration.");
  if (records.some(record => record.domain === "agriculture" || record.domain === "vegetation")) warnings.push("Vegetation proxies are not automatically crop yields or crop-health diagnoses. User-reported yield records and estimated indicators retain their distinct variable, unit and provenance; no crop suitability or yield risk is inferred.");
  return { schemaVersion: "1.0", kind: "ground-evidence", sourceId: "user-supplied-ground-evidence", importedAt: now.toISOString(), evidence: "user-supplied", verification: { status: "not_independently_verified", method: "structural_validation_only" }, recordCount: records.length, records, warnings };
}
