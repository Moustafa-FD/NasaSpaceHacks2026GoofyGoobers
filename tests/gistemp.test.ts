import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractGistemp, parseGlobalCsv } from "../apps/api/src/environment/gistemp.ts";
import { cfMonthlyDates, extractFile } from "../apps/api/src/environment/gistemp-worker.ts";

function int(value: number): Buffer { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; }
function name(value: string): Buffer { const text = Buffer.from(value); return Buffer.concat([int(text.length), text, Buffer.alloc((4 - text.length % 4) % 4)]); }
function floats(values: number[]): Buffer { const out = Buffer.alloc(values.length * 4); values.forEach((value, i) => out.writeFloatBE(value, i * 4)); return out; }
function shorts(values: number[]): Buffer { const out = Buffer.alloc(values.length * 2); values.forEach((value, i) => out.writeInt16BE(value, i * 2)); return out; }
function attrs(values: Array<[string, string | number, ("float" | "short")?]>): Buffer {
  if (!values.length) return Buffer.alloc(8);
  return Buffer.concat([int(12), int(values.length), ...values.map(([key, value, type]) => {
    const text = typeof value === "string";
    const data = text ? Buffer.from(value) : type === "short" ? shorts([value]) : floats([value]);
    return Buffer.concat([name(key), int(text ? 2 : type === "short" ? 3 : 5), int(text ? data.length : 1), data, Buffer.alloc((4 - data.length % 4) % 4)]);
  })]);
}

/** Deliberately tiny synthetic NetCDF3 record fixture, never exposed as NASA data. */
function netcdfFixture(): Buffer {
  const variable = (key: string, dims: number[], attributes: Buffer, type: number, size: number, offset: number) => Buffer.concat([name(key), int(dims.length), ...dims.map(int), attributes, int(type), int(size), int(offset)]);
  const makeHeader = (offset: number) => Buffer.concat([
    Buffer.from([67, 68, 70, 1]), int(2), int(10), int(3), name("time"), int(0), name("lat"), int(2), name("lon"), int(2), Buffer.alloc(8), int(11), int(4),
    variable("time", [0], attrs([["units", "days since 1880-01-01 00:00:00", undefined]]), 4, 4, offset + 16),
    variable("lat", [1], attrs([]), 5, 8, offset),
    variable("lon", [2], attrs([]), 5, 8, offset + 8),
    variable("tempanomaly", [0, 1, 2], attrs([["units", "C", undefined], ["scale_factor", 0.1, "float"], ["add_offset", 1, "float"], ["_FillValue", -9999, "short"]]), 3, 8, offset + 20),
  ]);
  const header = makeHeader(makeHeader(0).length);
  return Buffer.concat([header, floats([-30, 30]), floats([-90, 90]), int(0), shorts([0, 10, 20, -9999]), int(31), shorts([10, 20, 30, 40])]);
}

test("GISTEMP CSV preserves published decimal Celsius and missing monthly values", () => {
  const values = parseGlobalCsv("Land-Ocean: Global Means\nYear,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,J-D\n1880,-.19,-.25,-.09,-.16,-.10,-.21,-.18,-.10,-.14,-.23,-.20,***,-.17\n");
  assert.equal(values.length, 12);
  assert.deepEqual(values[0], { date: "1880-01", value: -0.19 });
  assert.equal(values.at(-1)?.value, null);
  assert.throws(() => parseGlobalCsv("Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec\n1880,99,0,0,0,0,0,0,0,0,0,0,0"), /units or values/);
});

test("CF monthly coordinates come from explicit units and reject unsupported calendars", () => {
  assert.deepEqual(cfMonthlyDates([0, 31, 60], "days since 2024-01-01"), ["2024-01", "2024-02", "2024-03"]);
  assert.deepEqual(cfMonthlyDates([0, 1, 12], "months since 1880-01-01"), ["1880-01", "1880-02", "1881-01"]);
  assert.throws(() => cfMonthlyDates([0], "days since 1880-01-01", "360_day"), /calendar/);
});

test("GISTEMP extraction reads record offsets, raw missing values and scale attributes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gistemp-fixture-"));
  try {
    const file = join(directory, "synthetic.nc");
    await writeFile(file, netcdfFixture());
    const result = await extractFile(file, { start: 1880, end: 1880, gridDate: "1880-01" });
    assert.deepEqual(result.availableRange, { start: "1880-01", end: "1880-02" });
    assert.equal(result.series[0].validCellCount, 3);
    assert.ok(Math.abs(result.series[0].value! - 2) < 1e-6);
    assert.ok(Math.abs(result.series[1].value! - 3.5) < 1e-6);
    assert.equal(result.frame?.values[1][1], null);
    const point = await extractGistemp(file, { start: "1880-01", end: "1880-02", point: { latitude: 30, longitude: 90 } });
    assert.equal(point.series[0].value, null);
    assert.ok(Math.abs(point.series[1].value! - 5) < 1e-6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
