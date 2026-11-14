import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGroundEvidence, validateGroundEvidence, type GroundEvidenceRecord, type GroundEvidenceRequest } from "../apps/api/src/environment/ground-evidence.ts";

function record(overrides: Partial<GroundEvidenceRecord> = {}): GroundEvidenceRecord {
  return { domain: "water-quality", variable: "nitrate", unit: "mg/L", value: 0, date: "2024-02-29T12:30:00Z", point: { latitude: 43.65, longitude: -79.38 }, stationId: "fixture-station", provenance: { sourceUrl: "https://example.org/fixture-not-a-real-measurement", recordId: "fixture-record", method: "measured" }, ...overrides };
}

function request(records: GroundEvidenceRecord[] = [record()]): GroundEvidenceRequest { return { schemaVersion: "1.0", kind: "ground-evidence", records }; }

test("ground import keeps separate source records, zeroes, nulls, water qualifiers and detection limits", () => {
  const input = request([
    record({ qualifiers: ["less-than", "provisional"], detectionLimit: 0.05, provenance: { sourceUrl: "https://example.org/fixture", recordId: "water-1", method: "reported", qualityFlag: "below detection", notes: "Fixture only; no real observation." } }),
    record({ value: null, stationId: "missing-station" })
  ]);
  assert.deepEqual(validateGroundEvidence(input), []);
  const result = normalizeGroundEvidence(input, new Date("2026-11-14T12:00:00Z"));
  assert.equal(result.sourceId, "user-supplied-ground-evidence");
  assert.equal(result.evidence, "user-supplied");
  assert.equal(result.verification.status, "not_independently_verified");
  assert.equal(result.verification.method, "structural_validation_only");
  assert.equal(result.importedAt, "2026-11-14T12:00:00.000Z");
  assert.equal(result.recordCount, 2);
  assert.deepEqual(result.records, input.records);
  assert.equal(result.records[0].value, 0);
  assert.equal(result.records[1].value, null);
  assert.deepEqual(result.records[0].qualifiers, ["less-than", "provisional"]);
  assert.equal(result.records[0].detectionLimit, 0.05);
  assert.ok(result.warnings.some(warning => warning.includes("never fetched")));
  assert.ok(result.warnings.some(warning => warning.includes("not converted to zero")));
  input.records[0].provenance.recordId = "mutated-after-import";
  input.records[0].point.latitude = 0;
  assert.equal(result.records[0].provenance.recordId, "water-1");
  assert.equal(result.records[0].point.latitude, 43.65);
});

test("ground noise imports preserve metric/duration/weighted period without decibel aggregation", () => {
  const input = request([
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)", value: 50, durationSeconds: 3600 }),
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)", value: 70, durationSeconds: 900 }),
    record({ domain: "noise", variable: "Lden", unit: "dB", value: 59, period: "Local 24-hour day; source applies +5 dB evening and +10 dB night weights." }),
    record({ domain: "noise", variable: "Lnight", unit: "dB(A)", value: 42, period: "Source-defined annual average of local 23:00-07:00 night periods." }),
    record({ domain: "noise", variable: "LAmax", unit: "dB(A)", value: null }),
    record({ domain: "noise", variable: "LCpeak", unit: "dB(C)", value: 85 })
  ]);
  const result = normalizeGroundEvidence(input);
  assert.equal(result.records.length, 6);
  assert.deepEqual(result.records.map(item => item.value), [50, 70, 59, 42, null, 85]);
  assert.deepEqual(result.records.map(item => item.unit), ["dB(A)", "dB(A)", "dB", "dB(A)", "dB(A)", "dB(C)"]);
  assert.equal(result.records[1].durationSeconds, 900);
  assert.equal(result.records[2].period, input.records[2].period);
  assert.ok(result.warnings.some(warning => warning.includes("No arithmetic averaging of decibels")));
});

test("ground agricultural yields and vegetation indicators remain distinct unverified evidence", () => {
  const result = normalizeGroundEvidence(request([
    record({ domain: "agriculture", variable: "harvested maize yield", unit: "kg/ha", value: 8200, facilityId: "submitter-asserted-site", provenance: { sourceUrl: "https://example.org/fixture-yield", recordId: "yield-fixture", method: "reported" } }),
    record({ domain: "vegetation", variable: "NDVI", unit: "dimensionless", value: 0.6, provenance: { sourceUrl: "https://example.org/fixture-ndvi", recordId: "ndvi-fixture", method: "estimated" } })
  ]));
  assert.equal(result.records[0].variable, "harvested maize yield");
  assert.equal(result.records[1].variable, "NDVI");
  assert.equal(result.records[0].facilityId, "submitter-asserted-site");
  assert.ok(result.warnings.some(warning => warning.includes("not automatically crop yields")));
  assert.ok(result.warnings.some(warning => warning.includes("no facility matching")));
});

test("ground import rejects unknown fields at every nested level", () => {
  const top = { ...request(), credentials: "unexpected" };
  const row = request([{ ...record(), futurePrediction: 123 } as GroundEvidenceRecord]);
  const point = request([record({ point: { latitude: 0, longitude: 0, altitude: 50 } as GroundEvidenceRecord["point"] })]);
  const source = request([record({ provenance: { ...record().provenance, verified: true } as GroundEvidenceRecord["provenance"] })]);
  for (const input of [top, row, point, source]) assert.ok(validateGroundEvidence(input).some(error => error.includes("unknown fields")));
});

test("ground import bounds record count, types and metadata lengths", () => {
  for (const input of [null, [], "record", {}, { ...request(), schemaVersion: "2.0" }, { ...request(), kind: "series" }, request([]), request(new Array(1)), request(Array.from({ length: 101 }, () => record()))]) assert.ok(validateGroundEvidence(input).length);
  assert.deepEqual(validateGroundEvidence(request(Array.from({ length: 100 }, () => record()))), []);
  const mutations: Array<Partial<GroundEvidenceRecord>> = [
    { domain: "economics" as GroundEvidenceRecord["domain"] }, { value: NaN }, { value: Infinity }, { value: "1" as unknown as number },
    { variable: " " }, { variable: "x".repeat(121) }, { unit: "x".repeat(81) }, { stationId: "" }, { stationId: "s".repeat(161) },
    { facilityId: "f".repeat(161) }, { point: { latitude: 91, longitude: 0 } }, { point: { latitude: 0, longitude: NaN } },
    { qualifiers: [] }, { qualifiers: new Array(2) }, { qualifiers: Array(11).fill("flag") }, { qualifiers: [" "] }, { qualifiers: ["x".repeat(121)] }, { detectionLimit: -1 }, { detectionLimit: Infinity }
  ];
  for (const mutation of mutations) assert.ok(validateGroundEvidence(request([record(mutation)])).length, JSON.stringify(mutation));
  for (const mutation of [{ recordId: "" }, { recordId: "r".repeat(201) }, { method: "verified" }, { qualityFlag: "x".repeat(121) }, { notes: "x".repeat(1001) }]) assert.ok(validateGroundEvidence(request([record({ provenance: { ...record().provenance, ...mutation } as GroundEvidenceRecord["provenance"] })])).length);
});

test("ground import requires actual UTC timestamps and HTTPS provenance without contacting sources", () => {
  for (const date of ["2023-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2024-01-01", "2024-01-01T24:00:00Z", "2024-01-01T00:00:00+00:00", "2024-01-01T00:00:00", "2024-01-01T00:00:60Z"]) assert.ok(validateGroundEvidence(request([record({ date })])).some(error => error.includes("date")), date);
  for (const date of ["2024-02-29T00:00:00Z", "2024-01-01T00:00:00.1Z", "2024-01-01T00:00:00.123Z"]) assert.deepEqual(validateGroundEvidence(request([record({ date })])), []);
  for (const sourceUrl of ["http://example.org/record", "javascript:alert(1)", "file:///record", "https://user:secret@example.org/record", "https://", "https://example.org/" + "x".repeat(2048)]) assert.ok(validateGroundEvidence(request([record({ provenance: { ...record().provenance, sourceUrl } })])).some(error => error.includes("sourceUrl")), sourceUrl);
  // An unreachable reference is still a reference; importing never fetches it.
  assert.equal(normalizeGroundEvidence(request([record({ provenance: { ...record().provenance, sourceUrl: "https://unreachable.example/fixture" } })])).recordCount, 1);
});

test("ground import requires meaningful acoustic metadata and keeps domain-only fields scoped", () => {
  const bad: GroundEvidenceRecord[] = [
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)" }),
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)", durationSeconds: 0 }),
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)", durationSeconds: Infinity }),
    record({ domain: "noise", variable: "LAeq", unit: "dB(A)", durationSeconds: 31_622_401 }),
    record({ domain: "noise", variable: "Lden", unit: "dB" }),
    record({ domain: "noise", variable: "Lnight", unit: "dB(A)", period: " " }),
    record({ domain: "noise", variable: "made-up-noise", unit: "dB" }),
    record({ domain: "noise", variable: "LAmax", unit: "dB", qualifiers: ["less-than"] }),
    record({ durationSeconds: 3600 }),
    record({ domain: "agriculture", period: "day" }),
    record({ domain: "vegetation", detectionLimit: 0.1 })
  ];
  for (const item of bad) assert.ok(validateGroundEvidence(request([item])).length, JSON.stringify(item));
});

test("ground normalizer refuses invalid evidence and an invalid import clock", () => {
  assert.throws(() => normalizeGroundEvidence(request([record({ value: Infinity })])), /validation failed/);
  assert.throws(() => normalizeGroundEvidence(request(), new Date(NaN)), /clock/);
});
