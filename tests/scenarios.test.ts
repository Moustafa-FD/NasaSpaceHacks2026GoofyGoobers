import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../apps/api/src/server.ts";
import { EnvironmentStore, REPOSITORY_ROOT } from "../apps/api/src/environment/store.ts";
import { ENVIRONMENT_DOMAINS, validateEnvironmentRequest, type EnvironmentRun } from "../packages/contracts/src/environment.ts";

async function launch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spaceapps-scenario-"));
  const api = await createApi({ store: new EnvironmentStore(root) });
  await new Promise<void>(done => api.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await api.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("spaceapps-scenario-")) throw new Error("Refusing unexpected temporary cleanup path");
    await rm(root, { recursive: true, force: true });
  });
  return async (body: unknown): Promise<{ run: EnvironmentRun; result?: Record<string, any> }> => {
    const accepted = await (await fetch(new URL("/v1/runs", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Record<string, any>;
    assert.ok(accepted.id, JSON.stringify(accepted));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const run = await (await fetch(new URL(`/v1/runs/${accepted.id}`, base))).json() as EnvironmentRun;
      if (run.status === "completed") return { run, result: await (await fetch(new URL(`/v1/runs/${accepted.id}/results`, base))).json() as Record<string, any> };
      if (run.status === "failed") return { run };
      await delay(150);
    }
    throw new Error("scenario run did not finish");
  };
}

test("scenario validation: explicit assumptions, sourced emissions, one location", () => {
  const plume = { schemaVersion: "1.0", kind: "plume-scenario", siteId: "colossus1", effectiveHeightM: 20 };
  assert.deepEqual(validateEnvironmentRequest(plume), []);
  assert.deepEqual(validateEnvironmentRequest({ ...plume, siteId: undefined, point: { latitude: 35, longitude: -90 }, receptors: [{ name: "School", lat: 35.01, lon: -90.0 }] }), []);
  assert.deepEqual(validateEnvironmentRequest({ ...plume, emission: { rateGs: 2, source: "permit X table 1", pollutant: "NOx" } }), []);
  for (const bad of [
    { ...plume, effectiveHeightM: undefined },                                  // stack height must be stated
    { ...plume, emission: { rateGs: 2 } },                                      // emission without a source
    { ...plume, point: { latitude: 35, longitude: -90 } },                      // both siteId and point
    { ...plume, receptors: [{ name: "x", lat: 1, lon: 1 }] },                   // receptors only with point
    { ...plume, landUse: "suburban" },
    { schemaVersion: "1.0", kind: "climate-projection", point: { latitude: 95, longitude: 0 } },
    { schemaVersion: "1.0", kind: "climate-projection", point: { latitude: 35, longitude: -90 }, perWindow: 9 },
  ]) assert.notDeepEqual(validateEnvironmentRequest(bad), [], JSON.stringify(bad));
  assert.deepEqual(validateEnvironmentRequest({ schemaVersion: "1.0", kind: "climate-projection", point: { latitude: 35, longitude: -90 }, perWindow: 2 }), []);
  const ids = ENVIRONMENT_DOMAINS.map(d => d.id);
  assert.ok(ids.includes("air-dispersion-screening") && ids.includes("climate-projection-2100"));
});

test("plume-scenario on a case-study site runs offline on committed GEOS-FP fields", { skip: !existsSync(join(REPOSITORY_ROOT, "data/cloudshadow/fields/colossus1")) }, async t => {
  const run = await launch(t);
  const { run: status, result } = await run({ schemaVersion: "1.0", kind: "plume-scenario", siteId: "colossus1", effectiveHeightM: 20,
    emission: { rateGs: 1, source: "unit-test stated assumption (1 g/s)", pollutant: "NOx" } });
  assert.equal(status.status, "completed", JSON.stringify(status.error));
  assert.equal(result!.kind, "plume-scenario");
  assert.equal(result!.evidence, "scenario");
  assert.ok(result!.frames.used >= 100, `wind frames ${result!.frames.used}`);
  const boxtown = result!.receptors.find((r: any) => r.name === "Boxtown");
  assert.ok(boxtown && boxtown.chiOverQ > 0 && boxtown.distanceM > 2500 && boxtown.distanceM < 3500);
  assert.ok(Math.abs(boxtown.concentrationUgM3 - boxtown.chiOverQ * 1e6) < 1e-12);
  assert.match(result!.assumptions.windFrames, /prepared GEOS-FP/);
});
