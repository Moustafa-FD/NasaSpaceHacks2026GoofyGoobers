import { Worker } from "node:worker_threads";

export const GISTEMP_CSV_URL = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts%2BdSST.csv";
export const GISTEMP_NETCDF_GZIP_URL = "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz";
export const GISTEMP_SOURCE = {
  id: "nasa-gistemp-v4",
  title: "NASA GISTEMP v4 land-ocean surface temperature anomaly",
  documentationUrl: "https://data.giss.nasa.gov/gistemp/data_v4.html",
  citationUrl: "https://data.giss.nasa.gov/gistemp/",
  baseline: "1951-1980",
  unit: "degC anomaly",
  gridDegrees: 2,
  smoothingKm: 1200,
  csvUrl: GISTEMP_CSV_URL,
  netcdfGzipUrl: GISTEMP_NETCDF_GZIP_URL,
} as const;

export interface GistempMonthlyPoint {
  date: string;
  value: number | null;
  validCellCount?: number;
  totalCellCount?: number;
  coverageFraction?: number;
}

export interface GistempQuery {
  /** Years or YYYY-MM; years expand to Jan/Dec. */
  start: number | string;
  end: number | string;
  bbox?: [number, number, number, number];
  /** WGS84 longitude/latitude. Uses the nearest source grid-cell center. */
  point?: { longitude: number; latitude: number };
  /** Optional requested monthly source grid, kept at native resolution. */
  gridDate?: string;
}

export interface GistempExtraction {
  sourceId: "nasa-gistemp-v4";
  variable: "surface_temperature_anomaly";
  unit: "degC anomaly";
  baseline: "1951-1980";
  gridDegrees: 2;
  smoothingKm: 1200;
  availableRange: { start: string; end: string };
  selection: { type: "global" | "bbox" | "point"; bbox?: [number, number, number, number]; point?: { longitude: number; latitude: number }; sourcePoint?: { longitude: number; latitude: number } };
  aggregation: "cosine_latitude_weighted_valid_cell_mean" | "nearest_grid_cell";
  series: GistempMonthlyPoint[];
  frame?: { date: string; latitudes: number[]; longitudes: number[]; values: Array<Array<number | null>> };
  warnings: string[];
}

/**
 * NASA's CSV is already decimal degrees Celsius, unlike its hundredths-Celsius
 * text tables. Keep *** missing months and ignore seasonal/annual columns.
 */
export function parseGlobalCsv(csv: string): GistempMonthlyPoint[] {
  const rows = csv.replace(/^\uFEFF/, "").split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  const headerIndex = rows.findIndex(row => /^Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec(?:,|$)/i.test(row));
  if (headerIndex < 0) throw new Error("GISTEMP CSV monthly column header was not found");
  const points: GistempMonthlyPoint[] = [];
  const seen = new Set<number>();
  for (const row of rows.slice(headerIndex + 1)) {
    const cells = row.split(",").map(value => value.trim());
    if (!/^\d{4}$/.test(cells[0] ?? "")) continue;
    const year = Number(cells[0]);
    if (year < 1880 || year > 2200 || seen.has(year) || cells.length < 13) throw new Error("GISTEMP CSV contains an invalid or duplicate year row");
    seen.add(year);
    for (let month = 1; month <= 12; month++) {
      const raw = cells[month];
      const missing = raw === "" || /^\*+$/.test(raw);
      const value = missing ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || Math.abs(value) > 50)) throw new Error("GISTEMP CSV contains invalid anomaly units or values; expected decimal degrees Celsius");
      points.push({ date: `${year}-${String(month).padStart(2, "0")}`, value });
    }
  }
  if (!points.length) throw new Error("GISTEMP CSV contains no monthly observations");
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/** Header and field decoding runs outside the API event loop. No downloads occur here. */
export function extractGistemp(ncPath: string, query: GistempQuery, signal?: AbortSignal): Promise<GistempExtraction> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("GISTEMP extraction aborted")); return; }
    const worker = new Worker(new URL("./gistemp-worker.ts", import.meta.url), {
      workerData: { ncPath, query },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error?: Error, result?: GistempExtraction) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const onAbort = () => finish(new Error("GISTEMP extraction aborted"));
    const timer = setTimeout(() => finish(new Error("GISTEMP extraction exceeded 60 seconds")), 60_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("error", error => finish(error));
    worker.once("exit", code => { if (!settled) finish(new Error(`GISTEMP worker exited without a result (${code})`)); });
    worker.once("message", (message: { result?: GistempExtraction; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.result) finish(undefined, message.result);
      else finish(new Error("GISTEMP worker returned an invalid message"));
    });
  });
}
