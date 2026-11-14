import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveQuality } from "../apps/web/js/adaptive-quality.js";

function renderFor(controller, start, duration, fps, eligible = true) {
  const step = 1000 / fps;
  for (let t = start + step; t <= start + duration; t += step) controller.sample(t, eligible);
  return start + duration;
}

test("sustained slow frames reduce tiers with warmup and cooldown", () => {
  const changes = [];
  const controller = new AdaptiveQuality({ onChange: (value) => changes.push(value) });
  renderFor(controller, 0, 6500, 15);
  assert.equal(controller.quality, "high", "startup and one slow window are insufficient");
  renderFor(controller, 6500, 2000, 15);
  assert.equal(controller.quality, "balanced");
  renderFor(controller, 8500, 6000, 15);
  assert.equal(controller.quality, "balanced", "quality must not oscillate during cooldown");
  renderFor(controller, 14500, 6500, 15);
  assert.equal(controller.quality, "low");
  assert.equal(changes.length, 2);
});

test("recovery needs three fast windows and ignores neutral frame rates", () => {
  const controller = new AdaptiveQuality({ quality: "low", warmupMs: 0 });
  renderFor(controller, 0, 5500, 60);
  assert.equal(controller.quality, "low");
  renderFor(controller, 5500, 1800, 60);
  assert.equal(controller.quality, "balanced");
  renderFor(controller, 7300, 13000, 36);
  assert.equal(controller.quality, "balanced");
  renderFor(controller, 20300, 7500, 60);
  assert.equal(controller.quality, "high");
});

test("hidden, paused, or manually controlled frames do not alter quality", () => {
  const controller = new AdaptiveQuality();
  renderFor(controller, 0, 40000, 8, false);
  assert.equal(controller.quality, "high");
  renderFor(controller, 40000, 6000, 15);
  assert.equal(controller.quality, "high", "resuming starts a fresh warmup and measurement history");
  controller.setQuality("low", 46000);
  renderFor(controller, 46000, 40000, 60, false);
  assert.equal(controller.quality, "low");
});
