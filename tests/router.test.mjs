import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.mjs";
import { chooseRoute, computeConfidence, MODE_WEIGHTS } from "../src/router.mjs";

const config = normalizeConfig({ ...DEFAULT_CONFIG, minimumConfidence: 0.1, groupStickiness: 0 });
const now = Date.parse("2026-08-20T00:00:00.000Z");
const group = (id, multiplier, ttftMs, extra = {}) => ({
  id, name: `G${id}`, multiplier, ttftMs, sampleCount: 100, lastSampleAt: new Date(now - 10_000).toISOString(), ...extra,
});

test("routing weights match AIHubRouter economy balanced and speed modes", () => {
  assert.deepEqual(MODE_WEIGHTS.economy, { price: 0.9, speed: 0.1 });
  assert.deepEqual(MODE_WEIGHTS.balanced, { price: 0.5, speed: 0.5 });
  assert.deepEqual(MODE_WEIGHTS.speed, { price: 0.1, speed: 0.9 });
});

test("confidence combines freshness and sample volume", () => {
  const fresh = computeConfidence({ sampleCount: 100, lastSampleAt: new Date(now).toISOString() }, now, 900);
  const stale = computeConfidence({ sampleCount: 100, lastSampleAt: new Date(now - 900_001).toISOString() }, now, 900);
  assert.ok(fresh > 0.9);
  assert.ok(stale < 0.3);
  assert.ok(stale < fresh);
});

test("economy chooses the lowest multiplier during failover", () => {
  const result = chooseRoute([group(1, 0.08, 600), group(2, 0.09, 200), group(3, 0.12, 50)], normalizeConfig({ ...config, mode: "economy" }), { now, currentGroupId: 1, excludeIds: [1], economyFailover: true });
  assert.equal(result.selected.id, 2);
  assert.equal(result.reason, "economy_failover");
});

test("speed mode pays for a much faster group", () => {
  const result = chooseRoute([group(1, 0.08, 1200), group(2, 0.1, 80)], normalizeConfig({ ...config, mode: "speed" }), { now, currentGroupId: 1 });
  assert.equal(result.selected.id, 2);
});

test("balanced mode keeps the cheaper group when speed difference is small", () => {
  const result = chooseRoute([group(1, 0.08, 100), group(2, 0.1, 95)], normalizeConfig({ ...config, mode: "balanced" }), { now, currentGroupId: 1 });
  assert.equal(result.selected.id, 1);
});

test("stale and out-of-range groups are filtered", () => {
  const result = chooseRoute([
    group(1, 0.08, 100, { lastSampleAt: new Date(now - 901_000).toISOString() }),
    group(2, 0.2, 100),
  ], config, { now });
  assert.equal(result.selected, null);
  assert.ok(result.candidates.every((candidate) => !candidate.eligible));
});

test("missing multiplier is not treated as a free group", () => {
  const result = chooseRoute([group(1, null, 100)], config, { now });
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].excludedReasons, ["multiplier"]);
});

test("manual switching remains available when automatic health data is stale", () => {
  const result = chooseRoute([
    group(1, 0.08, 100, { lastSampleAt: new Date(now - 901_000).toISOString() }),
  ], config, { now });
  assert.equal(result.candidates[0].eligible, false);
  assert.equal(result.candidates[0].switchEligible, true);
});
