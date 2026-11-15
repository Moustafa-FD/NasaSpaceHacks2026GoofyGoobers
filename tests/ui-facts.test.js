import test from "node:test";
import assert from "node:assert/strict";
import { confidence, measuredVerdict, claim, levelFact, beforeAfterYears, reportedWater, reportedPower } from "../apps/web/js/ui-facts.js";

test("confidence words follow the p-value thresholds", () => {
  assert.equal(confidence(0.006).word, "Strong evidence");
  assert.equal(confidence(0.047).word, "Clear evidence");
  assert.equal(confidence(0.051).word, "Weak evidence");
  assert.equal(confidence(0.3).word, "Not clear yet");
  assert.equal(confidence(NaN).level, 0);
});

test("verdicts describe a change, use before/after when both windows exist, and go flat when not significant", () => {
  const ba = { ba: { diff: -0.066, p: 0.0004, nA: 36, nB: 29 }, trendDiff: { slope: 0, p: 1 } };
  const v = measuredVerdict("green", ba, 0.5, "2024-06");
  assert.equal(v.since, 2024); assert.equal(v.dir, "worse"); assert.equal(v.amount, "13%");
  assert.match(claim("green", v), /^Since 2024, the site lost 13% of its greenery/);
  const flat = measuredVerdict("heat", { ba: { diff: 0.1, p: 0.35, nA: 36, nB: 30 } }, 20, "2024-06");
  assert.equal(flat.dir, "flat"); assert.match(claim("heat", flat), /hasn't clearly changed/);
  const trend = measuredVerdict("heat", { ba: null, trendDiff: { slope: 0.025, p: 0.001 } }, 20, "2012-01");
  assert.equal(trend.since, null); assert.match(claim("heat", trend), /^Each decade since 2003, nights at the site warmed 0\.3 °C/);
});

test("year facts are levels and before/after use the same variable on both sides", () => {
  const rows = new Map([
    [2022, { NO2_OMI_Local: 0.1, NO2_OMI_Surround: 2 }],
    [2023, { NO2_Local: 0.2, NO2_Surround: 2.2, NO2_OMI_Local: 0.1, NO2_OMI_Surround: 2 }],
    [2025, { NO2_Local: 0.5, NO2_Surround: 2.1 }],
  ]);
  assert.deepEqual(beforeAfterYears("air", rows, "2024-06"), { before: 2023, after: 2025, rowVar: "NO2" });
  assert.equal(levelFact("air", rows.get(2025), "NO2"), "24% more NO₂ than nearby");
  assert.equal(levelFact("heat", { LST_Night_Local: -0.16 }, "LST_Night"), "Nights 0.2 °C cooler than nearby");
  assert.equal(levelFact("green", {}, "NDVI"), null);
});

test("reported figures keep their scope and households/homes framing", () => {
  assert.equal(reportedWater("colossus1", {}).homes, "1,300–4,300");
  assert.equal(reportedWater("ashburn", undefined).missing, true);
  assert.match(reportedPower({ mw: 5000, value: "~5,000 MW of data-center capacity across Northern Virginia" }).text, /across Northern Virginia: about 4\.0 million homes/);
  assert.equal(reportedPower({ value: "Reported ~500 MW (single source)" }).missing, true);
});

test("only Clear/Strong measured results, published studies and documented figures are shown", async () => {
  const { shown } = await import("../apps/web/js/ui-facts.js");
  assert.equal(shown("air", { verdict: { p: 0.051 } }), false);
  assert.equal(shown("heat", { verdict: { p: 0.049 } }), true);
  assert.equal(shown("green", { verdict: { p: 0.2 } }), false);
  assert.equal(shown("air", { verdict: { p: 0.3 }, published: { text: "x" } }), true);
  assert.equal(shown("green", { verdict: null }), false);
  assert.equal(shown("water", { rep: { missing: true } }), false);
  assert.equal(reportedWater("ashburn", { kind: "official", value: "9% of county water", scope: "county-wide" }).text, "9% of county water");
  assert.equal(shown("power", { rep: reportedPower({ kind: "official", value: "41 turbines permitted" }) }), true);
});
