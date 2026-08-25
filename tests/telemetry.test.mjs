import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost, createResponseInspector, TelemetryStore } from "../src/telemetry.mjs";

test("stream inspector reads Responses usage and configured cost", () => {
  const headers = new Headers({ "x-aihub-cost": "0.005964" });
  const inspector = createResponseInspector({ model: "gpt-5.6-sol", pricingTable: {}, headers });
  inspector.consume(new TextEncoder().encode("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3267,\"output_tokens\":1087,\"total_tokens\":4354,\"input_tokens_details\":{\"cached_tokens\":180900}}}}\n\n"));
  assert.deepEqual(inspector.finish(), { inputTokens: 3267, outputTokens: 1087, totalTokens: 4354, cachedTokens: 180900, cost: 0.005964, costSource: "upstream_header" });
});

test("cost calculation is explicit and never guesses an absent price", () => {
  const usage = { inputTokens: 3000, outputTokens: 1000, cachedTokens: 1000 };
  assert.equal(calculateCost("gpt-5.6-sol", usage, {}), null);
  assert.equal(calculateCost("gpt-5.6-sol", usage, { "gpt-5.6-sol": { inputPerMillion: 1, cachedInputPerMillion: 0.2, outputPerMillion: 2 } }), 0.0042);
  assert.equal(calculateCost("gpt-5.6-sol", { inputTokens: 131235, outputTokens: 90, cachedTokens: 128896 }, { "gpt-5.6-sol": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 } }, 0.1), 0.0078843);
});

test("AIHub billing formula keeps cache reads separate and applies group multiplier", () => {
  const inspector = createResponseInspector({
    model: "gpt-5.6-sol",
    multiplier: 0.1,
    pricingTable: { "gpt-5.6-sol": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 } },
    headers: new Headers(),
  });
  inspector.consume(new TextEncoder().encode("data: {\"response\":{\"usage\":{\"input_tokens\":131235,\"output_tokens\":90,\"total_tokens\":131325,\"input_tokens_details\":{\"cached_tokens\":128896}}}}\n\n"));
  const result = inspector.finish();
  assert.equal(result.costSource, "estimated");
  assert.equal(result.cost, 0.0078843);
});

test("generic relay aliases and multipliers can estimate rollout cost", () => {
  const inspector = createResponseInspector({
    model: "gpt-5.6-sol",
    multiplier: 0.2,
    pricingTable: { "gpt-5.6-sol": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 } },
    headers: new Headers(),
  });
  inspector.consume(new TextEncoder().encode('data: {"response":{"usage":{"input_tokens":1000,"output_tokens":100}}}\n\n'));
  assert.equal(inspector.finish().cost, 0.0016);
});

test("model output fields named cost are not treated as billing data", () => {
  const inspector = createResponseInspector({ model: "gpt-5.6-sol", pricingTable: {}, headers: new Headers() });
  inspector.consume(new TextEncoder().encode(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "{\\\"cost\\\":999}" }], cost: 999 }] })));
  assert.equal(inspector.finish().cost, null);
});

test("telemetry store keeps newest records and totals", () => {
  const store = new TelemetryStore(2);
  store.add({ inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.1 });
  store.add({ inputTokens: 4, outputTokens: 1, totalTokens: 5, cost: null });
  store.add({ inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.2 });
  assert.equal(store.snapshot().requests.length, 2);
  assert.equal(store.snapshot().totals.requests, 3);
  assert.equal(store.snapshot().totals.totalTokens, 12);
  assert.ok(Math.abs(store.snapshot().totals.cost - 0.3) < 1e-12);
});

test("rollout completion absorbs proxy calls from the same turn", () => {
  const store = new TelemetryStore();
  store.add({ id: "proxy-1", source: "proxy", startedAt: "2026-08-20T00:00:01Z", model: "gpt-5.6-sol", inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.002, costSource: "upstream_header", groupId: 12, groupName: "A012" });
  store.add({ id: "turn-1", source: "codex_rollout", startedAt: "2026-08-20T00:00:00Z", finishedAt: "2026-08-20T00:00:05Z", model: "gpt-5.6-sol", inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedTokens: 6, cost: null });
  const snapshot = store.snapshot();
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].source, "combined");
  assert.equal(snapshot.requests[0].cost, 0.002);
  assert.equal(snapshot.requests[0].groupName, "A012");
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.totalTokens, 14);
});

test("balance deltas fill unpriced successful proxy requests", () => {
  const store = new TelemetryStore();
  store.add({ id: "proxy-1", source: "proxy", startedAt: "2026-08-20T00:00:01Z", model: "gpt-5.6-sol", totalTokens: 100, status: 200, outcome: "completed", cost: null });
  assert.equal(store.applyBalanceDelta(0.005964, { since: "2026-08-20T00:00:00Z" }), true);
  assert.equal(store.snapshot().requests[0].cost, 0.005964);
  assert.equal(store.snapshot().requests[0].costSource, "balance_delta");
});
