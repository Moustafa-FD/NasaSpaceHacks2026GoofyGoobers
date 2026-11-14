import { createHash } from "node:crypto";

export const NPRI_API_URL = "https://pollution-waste.canada.ca/sradapi/v2/npri/";
export const NPRI_SOURCE = {
  id: "canada-npri", countryCode: "CA", sectorCode: "518210",
  title: "Environment and Climate Change Canada National Pollutant Release Inventory",
  documentationUrl: "https://www.canada.ca/en/environment-climate-change/services/national-pollutant-release-inventory/using-interpreting-data.html",
  estimationGuideUrl: "https://www.canada.ca/en/environment-climate-change/services/national-pollutant-release-inventory/report/reporting-guide.html",
  searchUrl: "https://pollution-waste.canada.ca/national-release-inventory/",
  apiUrl: NPRI_API_URL,
} as const;

type ObjectValue = Record<string, unknown>;
export interface NpriEmissionsQuery { startYear?: number; endYear?: number; maxReports?: number }
export interface NpriProgress { stage: string; completedReports: number; totalReports: number; downloadedBytes: number }
export interface NpriOptions {
  fetchImpl?: typeof fetch; signal?: AbortSignal; maxBytes?: number; onProgress?: (progress: NpriProgress) => void;
}
export interface NpriLocation { latitude: number | null; longitude: number | null; sourceDatum: number | string | null }
export interface NpriFacility {
  id: string; sourceFacilityId: string; name: string; company: string | null; countryCode: "CA";
  city: string | null; province: string | null; address: string | null; location: NpriLocation;
  locationReportYear: number; reportYears: number[];
  classification: { status: "sector_candidate"; naicsCode: string; description: string | null; confirmedDatacenter: false };
}
export interface NpriMethod {
  sourceGroupCode: number | null; sourceDetailCode: number | null; category: string | null;
  amount: number | null; label: string | null; code: string | null; levelOfQuantification: unknown;
}
export interface NpriReleaseRecord {
  id: string; facilityId: string; sourceFacilityId: string; year: number; period: "annual";
  pollutant: { id: number; name: string; cas: string | null }; medium: "air" | "water" | "land" | "all_media";
  amount: number | null; units: string | null; missingReason: "not_reported" | null;
  evidence: "facility_reported_release"; isPermitLimit: false; location: NpriLocation;
  estimationBasis: { classification: "monitoring_based" | "estimate_based" | "mixed" | "not_stated"; methods: NpriMethod[] };
  quality: { preliminary: boolean; submissionDate: string | null; reportingThreshold: string | null };
  comments: string[]; provenance: { reportUrl: string; substanceUrl: string; reportSha256: string; substanceSha256: string };
}
export interface NpriDocument { url: string; sha256: string; bytes: number; retrievedAt: string }
export interface NpriEmissionsResult {
  sourceId: "canada-npri"; countryCode: "CA"; evidence: "facility_reported_release"; complete: boolean; retrievedAt: string;
  source: typeof NPRI_SOURCE; downloadedBytes: number; sourceRevision: string;
  coverage: { globalCoverage: false; geographicScope: "Canada NPRI reporting facilities only"; sectorCode: "518210";
    selectionBasis: "NAICS sector candidates, not independently verified datacenters";
    availableStartYear: number; availableEndYear: number; requestedStartYear: number; requestedEndYear: number;
    indexedReports: number; downloadedReports: number; maxReports: number; truncated: boolean; preliminaryYear: number | null };
  facilities: NpriFacility[]; records: NpriReleaseRecord[];
  reports: Array<{ facilityId: string; year: number; reportTypes: string[]; preliminary: boolean; substanceCount: number; sourceUrl: string }>;
  sourceDocuments: NpriDocument[];
  /** Environment-relevant source fields, with personnel/contact fields omitted. */
  raw: { years: number[]; publish: unknown; searchPages: unknown[]; reports: unknown[] };
  warnings: string[];
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid NPRI ${label}: expected an object`);
  return value as ObjectValue;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid NPRI ${label}: expected an array`);
  return value;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function localized(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value);
  return text(object(value, "localized text").en);
}
function id(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid NPRI ${label}`);
  return value;
}
function amount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid NPRI release quantity; refusing to replace it with zero");
  return value;
}
function location(facility: ObjectValue): NpriLocation {
  const geo = facility.geographicAddress == null ? {} : object(facility.geographicAddress, "geographic address");
  const coordinate = (key: string, limit: number) => {
    const value = geo[key];
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error("Invalid NPRI facility coordinate");
    return value;
  };
  return { latitude: coordinate("latitude", 90), longitude: coordinate("longitude", 180), sourceDatum: typeof geo.datum === "number" || typeof geo.datum === "string" ? geo.datum : null };
}
function comments(value: unknown): string[] {
  return value == null ? [] : list(value, "comments").map(entry => text(object(entry, "comment").comment)).filter((entry): entry is string => entry !== null);
}
function methodsClassification(methods: NpriMethod[]): NpriReleaseRecord["estimationBasis"]["classification"] {
  const monitoring = new Set(["M", "M1", "M3", "RQ"]);
  const estimated = new Set(["M2", "C", "E", "E1", "E2", "O", "SP"]);
  const classes = new Set(methods.map(method => monitoring.has(method.code ?? "") ? "monitoring_based" : estimated.has(method.code ?? "") ? "estimate_based" : "not_stated"));
  return classes.size === 1 ? [...classes][0] as "monitoring_based" | "estimate_based" | "not_stated" : classes.size > 1 ? "mixed" : "not_stated";
}
function yearBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1993 || value > new Date().getUTCFullYear()) throw new Error("NPRI years must be between 1993 and the current year");
  return value;
}

/** Uses the public APIs linked by NPRI's own search/report pages; no login or bulk archive is required. */
export async function fetchNpriEmissions(query: NpriEmissionsQuery = {}, options: NpriOptions = {}): Promise<NpriEmissionsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 65_536 || maxBytes > 64 * 1024 * 1024) throw new Error("NPRI maxBytes must be between 64 KiB and 64 MiB");
  const maxReports = query.maxReports ?? 100;
  if (!Number.isSafeInteger(maxReports) || maxReports < 1 || maxReports > 100) throw new Error("NPRI maxReports must be between 1 and 100");
  let downloadedBytes = 0;
  const sourceDocuments: NpriDocument[] = [];
  const retrieve = async (path: string, parameters: Record<string, string> = {}) => {
    const url = new URL(path, NPRI_API_URL);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await fetchImpl(url, { signal, redirect: "error", headers: { Accept: "application/json", "User-Agent": "GoofyGoobers-SpaceApps2026/0.2" } });
    if (!response.ok) throw new Error(`NPRI returned HTTP ${response.status} for ${path}`);
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("json")) throw new Error("NPRI returned a non-JSON document, not emissions records");
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > 1024 * 1024) { await response.body?.cancel(); throw new Error("NPRI response exceeded the 1 MiB per-document budget"); }
    if (!response.body) throw new Error("NPRI returned an empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength; downloadedBytes += next.value.byteLength;
        if (bytes > 1024 * 1024 || downloadedBytes > maxBytes) throw new Error("NPRI download budget exceeded; acquisition is incomplete");
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const body = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const document = { url: url.href, sha256, bytes, retrievedAt: new Date().toISOString() };
    sourceDocuments.push(document);
    return { data: JSON.parse(body.toString("utf8")) as unknown, document };
  };

  const [yearsDocument, publishDocument] = await Promise.all([retrieve("Data/ReportYears"), retrieve("Data/PublishDate")]);
  const years = list(yearsDocument.data, "report years").map(value => id(value, "report year")).filter(year => year >= 1993 && year <= new Date().getUTCFullYear()).sort((a, b) => a - b);
  if (!years.length) throw new Error("NPRI returned no available reporting years");
  const publish = object(publishDocument.data, "publication metadata");
  const preliminaryYear = publish.isPreliminaryData === true ? id(publish.reportYear, "preliminary report year") : null;
  const startYear = yearBound(query.startYear, years[0]); const endYear = yearBound(query.endYear, years.at(-1)!);
  if (startYear > endYear) throw new Error("NPRI year range must be ordered");
  const searchPages: unknown[] = [];
  const indexed: ObjectValue[] = [];
  let indexedReports = 0;
  const seenReports = new Set<string>();
  do {
    const response = await retrieve("Search", { fromYear: String(startYear), toYear: String(endYear), naicsCode: "518210", language: "en", start: String(indexed.length), length: String(Math.min(100, maxReports - indexed.length)), order: "year", direction: "descending" });
    const page = object(response.data, "search response"); searchPages.push(page);
    indexedReports = id(page.recordsFiltered, "filtered report count");
    const rows = list(page.data, "search rows");
    if (!rows.length && indexed.length < Math.min(indexedReports, maxReports)) throw new Error("NPRI search pagination ended before its reported count");
    for (const row of rows) {
      const item = object(row, "search report");
      const facility = id(item.npriID, "search facility ID"); const year = id(item.year, "search report year");
      const naics = object(item.naics, "search NAICS");
      if (naics.id !== 518210 || year < startYear || year > endYear) throw new Error("NPRI search ignored the requested sector or year filter");
      const key = `${year}/${facility}`;
      if (seenReports.has(key)) throw new Error("NPRI search returned duplicate facility-year reports");
      seenReports.add(key); indexed.push(item);
    }
    if (rows.length > maxReports || indexed.length > maxReports) throw new Error("NPRI search ignored the report limit");
  } while (indexed.length < Math.min(indexedReports, maxReports));
  indexed.sort((a, b) => Number(b.year) - Number(a.year) || Number(a.npriID) - Number(b.npriID));
  const facilities = new Map<string, NpriFacility>();
  const records: NpriReleaseRecord[] = [];
  const reports: NpriEmissionsResult["reports"] = [];
  const rawReports: unknown[] = [];
  let nextReport = 0; let completedReports = 0;
  const progress = () => options.onProgress?.({ stage: "npri:facility-reports", completedReports, totalReports: indexed.length, downloadedBytes });
  progress();
  // This group-code mapping is published in NPRI's own public substance-report client.
  const media = [[1, "air", "releaseAir"], [2, "water", "releaseWater"], [3, "land", "releaseLand"], [4, "all_media", "releaseAllMedia"]] as const;
  const worker = async () => {
    while (nextReport < indexed.length) {
      const row = indexed[nextReport++];
      const year = id(row.year, "report year"); const facilityNumber = id(row.npriID, "facility ID");
      const sourceFacilityId = String(facilityNumber); const facilityId = `npri:${sourceFacilityId}`;
      const reportDocument = await retrieve("Details/Report", { reportYear: String(year), npriId: sourceFacilityId });
      const report = object(reportDocument.data, "facility report");
      if (report.npriId !== facilityNumber || report.reportYear !== year) throw new Error("NPRI report identity did not match the requested facility and year");
      const facility = object(report.facility, "facility");
      const geo = location(facility);
      const industry = object(facility.industry, "facility industry");
      const naics = object(industry.naics6Primary, "facility NAICS");
      if (naics.id !== 518210) throw new Error("NPRI report primary sector differs from the requested candidate sector");
      const physical = facility.physicalAddress == null ? {} : object(facility.physicalAddress, "physical address");
      const company = report.company == null ? {} : object(report.company, "company");
      const current = facilities.get(facilityId);
      if (!current || current.locationReportYear < year) {
        facilities.set(facilityId, { id: facilityId, sourceFacilityId, name: text(facility.name) ?? text(row.facility) ?? sourceFacilityId, company: text(company.name), countryCode: "CA",
          city: text(physical.city), province: localized(physical.province), address: localized(facility.formattedAddress) ?? localized(physical.fullAddress), location: geo, locationReportYear: year,
          reportYears: [...new Set([...(current?.reportYears ?? []), year])].sort((a, b) => a - b),
          classification: { status: "sector_candidate", naicsCode: "518210", description: localized(naics), confirmedDatacenter: false } });
      } else current.reportYears = [...new Set([...current.reportYears, year])].sort((a, b) => a - b);
      const summaries = list(report.substanceSummary, "substance summaries");
      const detailRaw: unknown[] = [];
      const seenSubstances = new Set<number>();
      for (const summaryValue of summaries) {
        const summary = object(summaryValue, "substance summary");
        const substance = object(summary.substance, "substance");
        const substanceId = id(substance.id, "substance ID");
        if (seenSubstances.has(substanceId)) throw new Error("NPRI report returned duplicate substance summaries");
        seenSubstances.add(substanceId);
        const detailDocument = await retrieve("Details/Substance", { reportYear: String(year), npriId: sourceFacilityId, substanceId: String(substanceId) });
        const detail = object(detailDocument.data, "substance details");
        if (object(detail.substance, "detail substance").id !== substanceId) throw new Error("NPRI substance identity did not match the requested report");
        const release = detail.release == null ? {} : object(detail.release, "release details");
        const categories = list(release.categories ?? [], "release categories").map(value => object(value, "release category"));
        const units = localized(summary.unitType); const detailUnits = localized(detail.unitType);
        if (units !== detailUnits) throw new Error("NPRI summary and detailed quantity units differ");
        const sourceComments = [...new Set([...comments(summary.comments), ...comments(release.comments)])];
        for (const [group, medium, field] of media) {
          const methods: NpriMethod[] = categories.filter(category => category.groupCode === group).map(category => {
            const label = localized(category.basisOfEstimate);
            const code = label?.match(/^([A-Z]+\d*)\s*-/)?.[1] ?? null;
            const detailCode = category.detailCode == null ? {} : object(category.detailCode, "release detail code");
            return { sourceGroupCode: group, sourceDetailCode: typeof detailCode.id === "number" ? id(detailCode.id, "release detail code") : null,
              category: localized(detailCode), amount: amount(category.quantity), label, code, levelOfQuantification: category.levelOfQuantification ?? null };
          });
          const quantity = amount(summary[field]);
          records.push({ id: `${facilityId}:${year}:${substanceId}:${medium}`, facilityId, sourceFacilityId, year, period: "annual",
            pollutant: { id: substanceId, name: localized(substance) ?? String(substanceId), cas: text(substance.cas) }, medium, amount: quantity, units,
            missingReason: quantity === null ? "not_reported" : null, evidence: "facility_reported_release", isPermitLimit: false, location: geo,
            estimationBasis: { classification: methodsClassification(methods), methods },
            quality: { preliminary: year === preliminaryYear, submissionDate: text(report.submissionDate), reportingThreshold: localized(detail.threshold) ?? localized(summary.threshold) },
            comments: sourceComments, provenance: { reportUrl: reportDocument.document.url, substanceUrl: detailDocument.document.url,
              reportSha256: reportDocument.document.sha256, substanceSha256: detailDocument.document.sha256 } });
        }
        detailRaw.push({ substance: detail.substance, unitType: detail.unitType, threshold: detail.threshold, release: detail.release });
      }
      const reportTypes = list(report.reportTypes ?? [], "report types").map(localized).filter((value): value is string => value !== null);
      reports.push({ facilityId, year, reportTypes, preliminary: year === preliminaryYear, substanceCount: summaries.length, sourceUrl: reportDocument.document.url });
      rawReports.push({ npriId: facilityNumber, reportYear: year, submissionDate: report.submissionDate, reportTypes: report.reportTypes,
        facility: { name: facility.name, physicalAddress: facility.physicalAddress, geographicAddress: facility.geographicAddress, industry: facility.industry }, company: { name: company.name },
        substanceSummary: report.substanceSummary, releases: report.releases, substanceDetails: detailRaw });
      completedReports++; progress();
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, indexed.length) }, worker));
  const failed = workers.find((value): value is PromiseRejectedResult => value.status === "rejected");
  if (failed) throw failed.reason;
  records.sort((a, b) => b.year - a.year || a.facilityId.localeCompare(b.facilityId) || a.pollutant.id - b.pollutant.id || a.medium.localeCompare(b.medium));
  reports.sort((a, b) => b.year - a.year || a.facilityId.localeCompare(b.facilityId));
  sourceDocuments.sort((a, b) => a.url.localeCompare(b.url));
  const truncated = indexedReports > indexed.length;
  return {
    sourceId: "canada-npri", countryCode: "CA", evidence: "facility_reported_release", complete: !truncated, source: NPRI_SOURCE,
    retrievedAt: new Date().toISOString(), downloadedBytes, sourceRevision: createHash("sha256").update(sourceDocuments.map(document => `${document.url}:${document.sha256}`).join("\n")).digest("hex"),
    coverage: { globalCoverage: false, geographicScope: "Canada NPRI reporting facilities only", sectorCode: "518210", selectionBasis: "NAICS sector candidates, not independently verified datacenters",
      availableStartYear: years[0], availableEndYear: years.at(-1)!, requestedStartYear: startYear, requestedEndYear: endYear,
      indexedReports, downloadedReports: completedReports, maxReports, truncated, preliminaryYear },
    facilities: [...facilities.values()].sort((a, b) => a.id.localeCompare(b.id)), records, reports, sourceDocuments,
    raw: { years, publish, searchPages, reports: rawReports },
    warnings: [
      "This covers Canadian facilities reporting under NAICS 518210; the sector includes computing infrastructure, data processing, hosting and related services. These are candidates, not independently confirmed datacenters or a complete facility census.",
      "NPRI threshold-based reporting does not cover every pollutant or facility. Missing reports/amounts are unknown, never zero emissions.",
      "Reported annual releases may use monitoring, emission factors, calculations or engineering estimates. Original estimation methods are retained; values are not permit limits or ambient concentrations.",
      "Annual mass releases do not establish exposure, air/water quality changes or causal environmental impacts. Transport, chemistry and hydrology models plus validation are required.",
      "Do not sum overlapping pollutant categories (such as PM2.5 and PM10) or all-media totals together with their component media.",
      "Coordinate datum is retained from the source (often NAD83); no unverified facility-location or proximity matching is performed.",
      "The source's monthly annualReleases fields are reporting distributions; this adapter uses the annual quantities and does not reinterpret them as monthly mass.",
      ...(preliminaryYear === null ? [] : [`${preliminaryYear} NPRI data are preliminary according to the source publication metadata.`]),
      ...(truncated ? [`Acquisition capped at ${maxReports} of ${indexedReports} matching facility-year reports; recent years were requested first.`] : []),
    ],
  };
}
