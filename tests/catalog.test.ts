import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG_TARGETS, discoverCollections } from "../apps/api/src/environment/catalog.ts";

function fixtureFetch(overrides: Record<string, (url: URL) => Response> = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, "https://cmr.earthdata.nasa.gov");
    assert.equal(url.pathname, "/search/collections.json");
    assert.equal(url.searchParams.get("page_size"), "20");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    const shortName = url.searchParams.get("short_name")!;
    if (overrides[shortName]) return overrides[shortName](url);
    const versions = shortName === "OMNO2d" ? ["004", "003"] : ["test-version"];
    return Response.json({ feed: { entry: versions.map((version, i) => ({
      id: `C12345${i}-GES_DISC`, short_name: shortName, version_id: version,
      dataset_id: `${shortName} real-shape test fixture`, time_start: "2004-10-01T00:00:00.000Z",
      boxes: ["-90 -180 90 180"],
      links: [{ href: "https://disc.gsfc.nasa.gov/datasets/example", rel: "http://esipfed.org/ns/fedsearch/1.1/documentation#", title: "Documentation" }]
    })) } }, { headers: { "CMR-Hits": String(versions.length), "CMR-Search-After": "[1,\"cursor-even-on-short-pages\"]" } });
  }) as typeof fetch;
}

test("CMR inventory preserves versions, temporal coverage, and metadata-only provenance", async () => {
  const catalog = await discoverCollections({ fetchImpl: fixtureFetch() });
  assert.equal(catalog.completeForCuratedTargets, true);
  assert.equal(catalog.access, "metadata_only");
  assert.equal(catalog.queryScope, "curated_environmental_collections");
  assert.equal(catalog.targets.length, 6);
  assert.equal(catalog.records.length, 7);
  const omi = catalog.records.filter(record => record.targetId === "omi-no2");
  assert.deepEqual(omi.map(record => record.version), ["004", "003"]);
  assert.equal(omi[0].timeStart, "2004-10-01T00:00:00.000Z");
  assert.equal(omi[0].timeEnd, null);
  assert.equal(omi[0].sourceResource, "Giovanni");
  assert.match(omi[0].catalogUrl, /^https:\/\/cmr\.earthdata\.nasa\.gov\/search\/concepts\//);
  assert.deepEqual(omi[0].bbox, [-180, -90, 180, 90]);
  assert.equal(omi[0].links[0].title, "Documentation");
  assert.ok(catalog.records.every(record => record.retrievedAt === catalog.retrievedAt));
});

test("a missing target is explicit and is not replaced by invented metadata", async () => {
  const catalog = await discoverCollections({ fetchImpl: fixtureFetch({ MOD13C2: () => Response.json({ feed: { entry: [] } }, { headers: { "CMR-Hits": "0" } }) }) });
  assert.equal(catalog.completeForCuratedTargets, false);
  assert.equal(catalog.targets.find(target => target.targetId === "modis-vegetation")?.status, "not_found");
  assert.equal(catalog.records.some(record => record.targetId === "modis-vegetation"), false);
});

test("HTTP failures and invalid feeds remain explicit per target while other searches survive", async () => {
  const catalog = await discoverCollections({ fetchImpl: fixtureFetch({
    OMNO2d: () => new Response("upstream unavailable", { status: 503 }),
    MOD11C3: () => Response.json({ unexpected: [] })
  }) });
  assert.equal(catalog.completeForCuratedTargets, false);
  assert.equal(catalog.targets.filter(target => target.status === "error").length, 2);
  assert.match(catalog.targets.find(target => target.targetId === "omi-no2")!.error!.message, /HTTP 503/);
  assert.equal(catalog.records.some(record => record.targetId === "omi-no2"), false);
  assert.ok(catalog.records.some(record => record.targetId === "merra2-temperature"));
});

test("bounded searches disclose truncation instead of pretending all history/products were fetched", async () => {
  const catalog = await discoverCollections({ fetchImpl: fixtureFetch({ M2TMNXSLV: () => Response.json({ feed: { entry: [{
    id: "C1276812859-GES_DISC", short_name: "M2TMNXSLV", version_id: "5.12.4", dataset_id: "MERRA-2 monthly", boxes: ["-90 -180 90 180"]
  }] } }, { headers: { "CMR-Hits": "21" } }) }) });
  assert.equal(catalog.targets.find(target => target.targetId === "merra2-temperature")?.status, "truncated");
  assert.equal(catalog.completeForCuratedTargets, false);
});

test("aborted callers stop discovery instead of producing a misleading complete inventory", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled by caller"));
  let calls = 0;
  await assert.rejects(discoverCollections({ signal: controller.signal, fetchImpl: (async () => { calls++; return Response.json({}); }) as typeof fetch }), /Cancelled by caller/);
  assert.equal(calls, 0);
});

test("the curated target list maps all six families to official challenge resources", () => {
  assert.equal(new Set(CATALOG_TARGETS.map(target => target.id)).size, CATALOG_TARGETS.length);
  assert.ok(CATALOG_TARGETS.some(target => target.sourceResource === "Hydrology Time Series"));
  assert.equal(CATALOG_TARGETS.filter(target => target.sourceResource === "AppEEARS").length, 2);
});
