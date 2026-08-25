import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMonitorHttpServer, listen } from "../src/http-server.mjs";
import { VERSION } from "../src/version.mjs";

class FakeService extends EventEmitter {
  constructor() {
    super();
    this.config = { host: "127.0.0.1", port: 48160, aihubBaseUrl: "https://aihub.top", failoverEnabled: true, retryStatusCodes: [], modelPricing: {} };
    this.providers = [];
    this.currentGroupId = null;
  }
  status() { return { runtime: { running: true }, config: this.config, providers: [], telemetry: { requests: [], totals: {} } }; }
  async configure() { return this.status(); }
  async refresh() { return this.status(); }
}

test("HTTP server exposes health, state and dashboard only on loopback", async (context) => {
  const service = new FakeService();
  const server = createMonitorHttpServer(service);
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/healthz`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, version: VERSION });
  const state = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(state.runtime.running, true);
  const dashboard = await fetch(`${base}/`).then((response) => response.text());
  assert.match(dashboard, /AIHub \/ Codex Monitor/);
  assert.match(dashboard, /分组与健康/);
  assert.match(dashboard, /费用/);
});

test("retryable upstream failures switch once and are not replayed by the proxy", async (context) => {
  const service = new FakeService();
  service.config.retryStatusCodes = [429, 502, 503, 504];
  service.providers = [{ id: 12, name: "A012", multiplier: 0.08 }];
  service.currentGroupId = 12;
  service.records = [];
  service.recordRequest = (record) => service.records.push(record);
  let fetchCount = 0;
  let failoverCount = 0;
  service.failover = async () => {
    failoverCount += 1;
    return { switched: true, group: { id: 13, name: "A013" }, reason: "economy_failover" };
  };
  const server = createMonitorHttpServer(service, {
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
    },
  });
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
  });
  assert.equal(response.status, 429);
  assert.equal(fetchCount, 1);
  assert.equal(failoverCount, 1);
  assert.equal(service.records[0].failovers[0].scope, "next_codex_retry");
});

test("mutating browser API rejects non-loopback origins", async (context) => {
  const service = new FakeService();
  const server = createMonitorHttpServer(service);
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "PATCH",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 403);
});

test("credential reload endpoint refreshes the running service without exposing a token", async (context) => {
  const service = new FakeService();
  let reloads = 0;
  service.reloadCredentials = async () => {
    reloads += 1;
    return { ...service.status(), config: { credentialsConfigured: true } };
  };
  const server = createMonitorHttpServer(service);
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/actions/reload-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(reloads, 1);
  assert.equal(state.config.credentialsConfigured, true);
  assert.equal(JSON.stringify(state).toLowerCase().includes("token"), false);
});

test("Responses proxy records model, reasoning, tokens, cost and latency", async (context) => {
  const service = new FakeService();
  service.providers = [{ id: 12, name: "A012-Plus", multiplier: 0.08 }];
  service.currentGroupId = 12;
  service.records = [];
  service.recordRequest = (record) => service.records.push(record);
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers.get("authorization"), "Bearer model-secret");
    return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":3267,"output_tokens":1087,"total_tokens":4354}}}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-aihub-cost": "0.005964" },
    });
  };
  const server = createMonitorHttpServer(service, { fetchImpl });
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer model-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", reasoning: { effort: "xhigh" }, stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.equal(service.records.length, 1);
  assert.equal(service.records[0].model, "gpt-5.6-sol");
  assert.equal(service.records[0].reasoningEffort, "xhigh");
  assert.equal(service.records[0].totalTokens, 4354);
  assert.equal(service.records[0].cost, 0.005964);
  assert.ok(service.records[0].firstByteMs >= 0);
  assert.equal(JSON.stringify(service.records).includes("model-secret"), false);
});

test("Responses proxy estimates AIHub charged cost with the active group multiplier", async (context) => {
  const service = new FakeService();
  service.config.modelPricing = { "gpt-5.6-sol": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 } };
  service.providers = [{ id: 12, name: "A012-Plus", multiplier: 0.1 }];
  service.currentGroupId = 12;
  service.records = [];
  service.recordRequest = (record) => service.records.push(record);
  const server = createMonitorHttpServer(service, {
    fetchImpl: async () => new Response('data: {"response":{"usage":{"input_tokens":131235,"output_tokens":90,"total_tokens":131325,"input_tokens_details":{"cached_tokens":128896}}}}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });
  await listen(server, "127.0.0.1", 0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
  }).then((response) => response.text());
  assert.equal(service.records[0].costSource, "estimated");
  assert.equal(service.records[0].cost, 0.0078843);
});
