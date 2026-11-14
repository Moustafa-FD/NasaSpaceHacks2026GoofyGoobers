import { readFile, stat } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { NetCDFReader } from "netcdfjs";
import type { GistempExtraction, GistempQuery } from "./gistemp.ts";

interface Attribute { name: string; value: unknown }
interface Variable { name: string; dimensions: number[]; attributes: Attribute[]; type: string; size: number; offset: number; record: boolean }

function numericValues(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numericValues);
  if (typeof value === "number") return [value];
  throw new Error("Expected numeric NetCDF coordinate data");
}
function attr(variable: Variable, name: string): unknown { return variable.attributes.find(item => item.name === name)?.value; }
function numericAttr(variable: Variable, name: string, fallback: number): number {
  const raw = attr(variable, name);
  if (raw === undefined) return fallback;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${name} attribute`);
  return value;
}

export function cfMonthlyDates(values: number[], units: string, calendar = "standard"): string[] {
  if (!["standard", "gregorian", "proleptic_gregorian"].includes(calendar)) throw new Error(`Unsupported NetCDF calendar: ${calendar}`);
  const match = /^(days?|hours?|seconds?|months?) since (\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::([\d.]+))?)?(?:\s*(?:UTC|Z))?$/i.exec(units.trim());
  if (!match) throw new Error(`Unsupported CF time units: ${units}`);
  const [, unit, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const epoch = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return values.map(value => {
    if (!Number.isFinite(value)) throw new Error("Non-finite NetCDF time coordinate");
    let date: Date;
    if (/^month/i.test(unit)) {
      if (!Number.isInteger(value)) throw new Error("Fractional CF month coordinates are unsupported");
      date = new Date(Date.UTC(Number(year), Number(month) - 1 + value, Number(day)));
    } else {
      const multiplier = /^day/i.test(unit) ? 86_400_000 : /^hour/i.test(unit) ? 3_600_000 : 1000;
      date = new Date(epoch + value * multiplier);
    }
    if (!Number.isFinite(date.getTime())) throw new Error("NetCDF time coordinate is outside the date range");
    return date.toISOString().slice(0, 7);
  });
}

function bound(value: number | string, end: boolean): string {
  const text = String(value);
  if (/^\d{4}$/.test(text)) return `${text}-${end ? "12" : "01"}`;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return text;
  throw new Error("GISTEMP date bounds must be years or YYYY-MM");
}

function rawReader(data: Buffer, type: string): { bytes: number; read: (offset: number) => number } {
  switch (type) {
    case "byte": return { bytes: 1, read: offset => data.readInt8(offset) };
    case "short": return { bytes: 2, read: offset => data.readInt16BE(offset) };
    case "int": return { bytes: 4, read: offset => data.readInt32BE(offset) };
    case "float": return { bytes: 4, read: offset => data.readFloatBE(offset) };
    case "double": return { bytes: 8, read: offset => data.readDoubleBE(offset) };
    default: throw new Error(`Unsupported anomaly encoding: ${type}`);
  }
}

export async function extractFile(ncPath: string, query: GistempQuery): Promise<GistempExtraction> {
  const fileInfo = await stat(ncPath);
  if (!fileInfo.isFile() || fileInfo.size > 200 * 1024 * 1024) throw new Error("GISTEMP file must be a regular uncompressed NetCDF file below 200 MiB");
  const data = await readFile(ncPath);
  const reader = new NetCDFReader(data);
  const variables = reader.variables as unknown as Variable[];
  const findCoordinate = (pattern: RegExp) => {
    const variable = variables.find(item => pattern.test(item.name) && item.dimensions.length === 1);
    if (!variable) throw new Error(`Missing coordinate matching ${pattern}`);
    return variable;
  };
  const latitude = findCoordinate(/^(lat|latitude)$/i);
  const longitude = findCoordinate(/^(lon|longitude)$/i);
  const time = findCoordinate(/^time$/i);
  const lats = numericValues(reader.getDataVariable(latitude.name));
  const lons = numericValues(reader.getDataVariable(longitude.name)).map(value => value > 180 ? value - 360 : value);
  const times = cfMonthlyDates(numericValues(reader.getDataVariable(time.name)), String(attr(time, "units") ?? ""), String(attr(time, "calendar") ?? "standard"));
  if (!lats.length || !lons.length || !times.length || new Set(times).size !== times.length) throw new Error("Invalid or non-monthly GISTEMP coordinates");
  if (lats.some(value => !Number.isFinite(value) || value < -90 || value > 90) || lons.some(value => !Number.isFinite(value) || value < -180 || value > 180)) throw new Error("Invalid geographic coordinates");
  const dimensions = [time.dimensions[0], latitude.dimensions[0], longitude.dimensions[0]];
  const field = variables.find(item => item.name === "tempanomaly") ?? variables.find(item => item.dimensions.length === 3 && dimensions.every(id => item.dimensions.includes(id)));
  if (!field || field.dimensions.length !== 3 || !dimensions.every(id => field.dimensions.includes(id))) throw new Error("Temperature anomaly variable must use time, latitude and longitude dimensions");
  const fieldUnits = String(attr(field, "units") ?? "");
  if (!/celsius|deg.?c|kelvin|^K$|^C$/i.test(fieldUnits)) throw new Error(`Unrecognized temperature anomaly units: ${fieldUnits}`);
  const start = bound(query.start, false), end = bound(query.end, true);
  if (start > end) throw new Error("GISTEMP date range must be ordered");
  if (query.bbox && query.point) throw new Error("Choose either bbox or point, not both");
  let latIndices = lats.map((_, i) => i), lonIndices = lons.map((_, i) => i);
  const selection: GistempExtraction["selection"] = { type: "global" };
  if (query.bbox) {
    const [west, south, east, north] = query.bbox;
    if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("Invalid WGS84 bbox; dateline crossing is not supported");
    latIndices = latIndices.filter(i => lats[i] >= south && lats[i] <= north);
    lonIndices = lonIndices.filter(i => lons[i] >= west && lons[i] <= east);
    selection.type = "bbox";
    selection.bbox = query.bbox;
  } else if (query.point) {
    const { latitude: lat, longitude: lon } = query.point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("Invalid WGS84 point");
    const nearest = (values: number[], target: number, cyclic: boolean) => values.reduce((best, value, index) => {
      const distance = (candidate: number) => cyclic ? Math.min(Math.abs(candidate - target), 360 - Math.abs(candidate - target)) : Math.abs(candidate - target);
      return distance(value) < distance(values[best]) ? index : best;
    }, 0);
    latIndices = [nearest(lats, lat, false)]; lonIndices = [nearest(lons, lon, true)];
    selection.type = "point"; selection.point = query.point;
    selection.sourcePoint = { latitude: lats[latIndices[0]], longitude: lons[lonIndices[0]] };
  }
  if (!latIndices.length || !lonIndices.length) throw new Error("Requested bbox contains no source grid-cell centers; enlarge it or explicitly request a point");
  const selectedTimes = times.map((date, index) => ({ date, index })).filter(item => item.date >= start && item.date <= end);
  if (!selectedTimes.length) throw new Error("No source months overlap the requested date range");
  if (query.gridDate && !selectedTimes.some(item => item.date === query.gridDate)) throw new Error("gridDate must be an available month inside the selected date range");
  const sizes = field.dimensions.map(id => id === time.dimensions[0] ? times.length : id === latitude.dimensions[0] ? lats.length : lons.length);
  const timeAxis = field.dimensions.indexOf(time.dimensions[0]);
  const latAxis = field.dimensions.indexOf(latitude.dimensions[0]);
  const lonAxis = field.dimensions.indexOf(longitude.dimensions[0]);
  if (field.record && (timeAxis !== 0 || !reader.recordDimension.recordStep)) throw new Error("Unsupported NetCDF record layout");
  const encoding = rawReader(data, field.type);
  const fill = numericAttr(field, "_FillValue", Number.NaN);
  const missing = numericAttr(field, "missing_value", Number.NaN);
  const scale = numericAttr(field, "scale_factor", 1), offset = numericAttr(field, "add_offset", 0);
  const readCell = (t: number, lat: number, lon: number): number | null => {
    const indices = [0, 0, 0]; indices[timeAxis] = t; indices[latAxis] = lat; indices[lonAxis] = lon;
    let flat = 0;
    for (let axis = field.record ? 1 : 0; axis < 3; axis++) flat = flat * sizes[axis] + indices[axis];
    const position = field.offset + (field.record ? t * reader.recordDimension.recordStep! : 0) + flat * encoding.bytes;
    if (position < 0 || position + encoding.bytes > data.length) throw new Error("Truncated NetCDF anomaly data");
    const raw = encoding.read(position);
    if (!Number.isFinite(raw) || raw === fill || raw === missing) return null;
    const value = raw * scale + offset;
    return Number.isFinite(value) ? value : null;
  };
  const result: GistempExtraction = {
    sourceId: "nasa-gistemp-v4", variable: "surface_temperature_anomaly", unit: "degC anomaly", baseline: "1951-1980", gridDegrees: 2, smoothingKm: 1200,
    availableRange: { start: [...times].sort()[0], end: [...times].sort().at(-1)! }, selection,
    aggregation: selection.type === "point" ? "nearest_grid_cell" : "cosine_latitude_weighted_valid_cell_mean", series: [],
    warnings: [
      "GISTEMP is an analyzed land-air/sea-surface temperature anomaly relative to 1951-1980, not absolute air temperature or a forecast.",
      "The source uses a 2-degree grid and 1200-km smoothing; values cannot establish facility-scale effects or data-center attribution.",
      "Regional means weight available grid-cell centers by cosine(latitude); they are not exact polygon-area integrals.",
      "A mean of available global grid cells may differ from NASA's separately published global index because missing-data handling differs.",
    ],
  };
  const totalCellCount = latIndices.length * lonIndices.length;
  for (const { date, index } of selectedTimes) {
    let sum = 0, weights = 0, validCellCount = 0;
    const values: Array<Array<number | null>> = [];
    for (const lat of latIndices) {
      const row: Array<number | null> = [];
      const weight = Math.cos(lats[lat] * Math.PI / 180);
      for (const lon of lonIndices) {
        const value = readCell(index, lat, lon);
        if (value !== null) { sum += value * weight; weights += weight; validCellCount++; }
        if (date === query.gridDate) row.push(value);
      }
      if (date === query.gridDate) values.push(row);
    }
    result.series.push({ date, value: weights > 0 ? sum / weights : null, validCellCount, totalCellCount, coverageFraction: validCellCount / totalCellCount });
    if (date === query.gridDate) result.frame = { date, latitudes: latIndices.map(i => lats[i]), longitudes: lonIndices.map(i => lons[i]), values };
  }
  result.series.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

if (parentPort) {
  const { ncPath, query } = workerData as { ncPath: string; query: GistempQuery };
  void extractFile(ncPath, query).then(result => parentPort!.postMessage({ result }), error => parentPort!.postMessage({ error: error instanceof Error ? error.message : "GISTEMP extraction failed" }));
}
