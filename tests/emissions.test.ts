import test from "node:test";
import assert from "node:assert/strict";
import { fetchNpriEmissions, NPRI_API_URL, type NpriEmissionsQuery } from "../apps/api/src/environment/emissions.ts";

/** Small synthetic API fixtures, separate from live downloaded facility records. */
function fixture() {
  const substance = { id: 13506, en: "Nitrogen oxides (expressed as nitrogen dioxide)", cas: "11104-93-1" };
  const rows = [2025, 2024, 2023].map(year => ({ npriID: 35136, year, facility: "Synthetic sector candidate", naics: { id: 518210 } }));
  const report = (year: number) => ({ npriId: 35136, reportYear: year, submissionDate: "2025-05-22T00:00:00", reportTypes: [{ en: year === 2025 ? "NPRI DNMC" : "NPRI Inventory" }],
    facility: { name: "Synthetic sector candidate", industry: { naics6Primary: { id: 518210, en: "Computing infrastructure and hosting" } },
      geographicAddress: { latitude: 45.6, longitude: -73.3, datum: 1983 }, physicalAddress: { city: "Fixture City", province: { en: "Quebec" } } },
    company: { name: "Synthetic company" }, contacts: [{ email: "unneeded-person@example.test" }],
    substanceSummary: year === 2025 ? [] : [{ substance, unitType: { en: "tonnes" }, releaseAir: 45.698, releaseWater: null, releaseLand: 0, releaseAllMedia: null, threshold: { en: "Yes" }, comments: [] }], releases: [],
  });
  const detail = () => ({ substance, unitType: { en: "tonnes" }, threshold: { en: "Reporting criteria met" }, release: {
    categories: [
      { groupCode: 1, detailCode: { id: 1, en: "Stack / Point" }, quantity: 45.698, basisOfEstimate: { en: "E2 - Published Emission Factors" } },
      { groupCode: 2, detailCode: { id: 8, en: "Discharges" }, quantity: null, basisOfEstimate: { en: "M3 - Source Testing" } },
      { groupCode: 3, detailCode: { id: 9, en: "Spills" }, quantity: 0, basisOfEstimate: { en: "C - Mass Balance" } },
    ], comments: [{ comment: "Synthetic annual reporting comment" }], annualReleases: { monthly: { jan: 100 } },
  } });
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    assert.ok(url.href.startsWith(NPRI_API_URL));
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.redirect, "error");
    const path = url.pathname.split("/npri/")[1];
    if (path === "Data/ReportYears") return Response.json([1993, 2023, 2024, 2025]);
    if (path === "Data/PublishDate") return Response.json({ reportYear: 2025, isPreliminaryData: true, publishDate: "2026-09-17T00:00:00" });
    if (path === "Search") {
      assert.equal(url.searchParams.get("naicsCode"), "518210");
      assert.equal(url.searchParams.get("order"), "year");
      const selected = rows.filter(row => row.year >= Number(url.searchParams.get("fromYear")) && row.year <= Number(url.searchParams.get("toYear")));
      const start = Number(url.searchParams.get("start")); const length = Number(url.searchParams.get("length"));
      return Response.json({ recordsFiltered: selected.length, recordsTotal: selected.length, data: selected.slice(start, start + length) });
    }
    if (path === "Details/Report") return Response.json(report(Number(url.searchParams.get("reportYear"))));
    if (path === "Details/Substance") return Response.json(detail());
    throw new Error("Unexpected fixture request");
  }) as typeof fetch;
  return { fetchImpl, calls, report, detail };
}

test("NPRI retains annual amounts, units, missing versus zero, estimation basis and provenance", async () => {
  const f = fixture(); const progress: number[] = [];
  const data = await fetchNpriEmissions({}, { fetchImpl: f.fetchImpl, onProgress: value => progress.push(value.completedReports) });
  assert.equal(data.complete, true);
  assert.equal(data.coverage.globalCoverage, false);
  assert.equal(data.coverage.downloadedReports, 3);
  assert.equal(data.facilities.length, 1);
  assert.equal(data.facilities[0].classification.confirmedDatacenter, false);
  assert.equal(data.facilities[0].location.sourceDatum, 1983);
  assert.deepEqual(data.facilities[0].reportYears, [2023, 2024, 2025]);
  const air = data.records.find(row => row.year === 2024 && row.medium === "air")!;
  assert.equal(air.amount, 45.698); assert.equal(air.units, "tonnes"); assert.equal(air.period, "annual");
  assert.equal(air.estimationBasis.classification, "estimate_based");
  assert.equal(air.estimationBasis.methods[0].code, "E2");
  assert.equal(air.isPermitLimit, false);
  assert.match(air.provenance.substanceSha256, /^[a-f0-9]{64}$/);
  const water = data.records.find(row => row.year === 2024 && row.medium === "water")!;
  assert.equal(water.amount, null); assert.equal(water.missingReason, "not_reported");
  assert.equal(water.estimationBasis.classification, "monitoring_based");
  const land = data.records.find(row => row.year === 2024 && row.medium === "land")!;
  assert.equal(land.amount, 0); assert.equal(land.missingReason, null);
  assert.equal(land.estimationBasis.classification, "estimate_based");
  assert.equal(data.records.length, 8);
  assert.deepEqual(progress, [0, 1, 2, 3]);
  assert.ok(!JSON.stringify(data.raw).includes("unneeded-person"));
  assert.equal(data.sourceDocuments.length, 8);
});

test("NPRI reports preliminary/no-longer-meets-criteria years without inventing releases", async () => {
  const data = await fetchNpriEmissions({ startYear: 2025, endYear: 2025 }, { fetchImpl: fixture().fetchImpl });
  assert.equal(data.coverage.preliminaryYear, 2025);
  assert.equal(data.reports[0].preliminary, true);
  assert.deepEqual(data.reports[0].reportTypes, ["NPRI DNMC"]);
  assert.deepEqual(data.records, []);
});

test("NPRI marks capped acquisitions as incomplete and requests recent years first", async () => {
  const data = await fetchNpriEmissions({ maxReports: 1 }, { fetchImpl: fixture().fetchImpl });
  assert.equal(data.complete, false); assert.equal(data.coverage.truncated, true);
  assert.equal(data.coverage.indexedReports, 3); assert.equal(data.coverage.downloadedReports, 1);
  assert.equal(data.reports[0].year, 2025);
  assert.ok(data.warnings.some(value => value.includes("capped")));
});

test("NPRI fails on ignored sector filters, changed identity and inconsistent units", async () => {
  for (const problem of ["sector", "identity", "units"]) {
    const f = fixture();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await f.fetchImpl(input, init); const value = await response.json() as Record<string, any>;
      const url = String(input);
      if (problem === "sector" && url.includes("/Search?")) value.data[0].naics.id = 123456;
      if (problem === "identity" && url.includes("Details/Report?")) value.npriId = 99;
      if (problem === "units" && url.includes("Details/Substance?")) value.unitType.en = "kg";
      return Response.json(value);
    }) as typeof fetch;
    await assert.rejects(fetchNpriEmissions({ startYear: 2024, endYear: 2024 }, { fetchImpl }), /filter|identity|units/);
  }
});

test("NPRI refuses HTML/error responses and oversized documents", async () => {
  for (const response of [() => new Response("<html>not a CSV</html>", { headers: { "content-type": "text/html" } }), () => new Response("unavailable", { status: 503 }), () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000000" } })]) {
    await assert.rejects(fetchNpriEmissions({}, { fetchImpl: (async () => response()) as typeof fetch }), /non-JSON|HTTP 503|budget/);
  }
});

test("NPRI validates request caps and ordered dates before facility downloads", async () => {
  for (const query of [{ maxReports: 101 }, { maxReports: 0 }, { startYear: 2025, endYear: 2024 }, { startYear: 1900 }]) {
    await assert.rejects(fetchNpriEmissions(query as NpriEmissionsQuery, { fetchImpl: fixture().fetchImpl }), /NPRI/);
  }
  await assert.rejects(fetchNpriEmissions({}, { maxBytes: 0, fetchImpl: fixture().fetchImpl }), /maxBytes/);
});

test("NPRI aggregate byte budget also bounds responses without content-length", async () => {
  const f = fixture();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await f.fetchImpl(input, init);
    const value = await response.json() as Record<string, unknown>;
    if (String(input).includes("Details/Report?")) value.padding = "x".repeat(70_000);
    return Response.json(value);
  }) as typeof fetch;
  await assert.rejects(fetchNpriEmissions({ startYear: 2024, endYear: 2024 }, { fetchImpl, maxBytes: 65_536 }), /download budget/);
});
