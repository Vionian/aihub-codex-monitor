import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.mjs";
import { MonitorService, deriveProviderHealth, deriveProviderModelSupport, freshnessLabel } from "../src/service.mjs";

function ok(value) {
  return new Response(JSON.stringify({ code: 0, data: value }), { status: 200, headers: { "content-type": "application/json" } });
}

test("provider health labels distinguish explicit, local, cooling and unverified states", () => {
  const now = Date.parse("2026-08-22T00:00:00Z");
  assert.equal(deriveProviderHealth({ status: "observed", available: null }, { samples: 0 }, now).healthLabel, "未检测");
  assert.equal(deriveProviderHealth({ available: true }, {}, now).healthLabel, "可用");
  assert.equal(deriveProviderHealth({ available: false }, {}, now).healthLabel, "异常");
  assert.equal(deriveProviderHealth({ cooldownUntil: "2026-08-22T00:01:00Z" }, {}, now).healthLabel, "冷却中");
  assert.equal(deriveProviderHealth({}, { samples: 2, successRate: 1 }, now).healthSource, "local_requests");
  assert.equal(freshnessLabel(null), "未采样");
  assert.equal(freshnessLabel(12), "12秒前");
  assert.equal(deriveProviderModelSupport({ models: ["gpt-5.6-sol"] }, {}, "gpt-5.6-sol"), "supported");
  assert.equal(deriveProviderModelSupport({ models: ["gpt-5.6-luna"] }, {}, "gpt-5.6-sol"), "unsupported");
  assert.equal(deriveProviderModelSupport({}, {}, "gpt-5.6-sol"), "unknown");
});

test("provider history is retained as local trend data", () => {
  const service = new MonitorService({ config: normalizeConfig({ rolloutEnabled: false }), dataDir: "unused", env: {} });
  service.recordRequest({ id: "r1", groupId: 4, source: "proxy", startedAt: "2026-08-22T00:00:00Z", finishedAt: "2026-08-22T00:00:01Z", firstByteMs: 300, inputTokens: 100, cachedTokens: 25, outputTokens: 10, state: "completed", outcome: "success", status: 200 });
  const provider = service.status().providers.find((item) => item.id === 4);
  assert.equal(provider, undefined);
  assert.equal(service.providerHistory.get("4")[0].cacheHitRate, 0.25);
});

test("monitor logs in with email and password before reading private AIHub data", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, authorization: options.headers.authorization });
    if (path === "/api/v1/auth/login") return ok({ access_token: "session-access", refresh_token: "session-refresh", expires_in: 3600 });
    if (path === "/api/v1/public/groups/usage-stats") return ok({ items: [{ group_id: 12, code: "A012", rate_multiplier: 0.08, avg_ttft_ms: 500, sample_count: 100, last_sample_at: new Date().toISOString() }] });
    if (path === "/api/v1/groups/available") return ok([{ id: 12, name: "A012", status: "available" }]);
    if (path === "/api/v1/groups/rates") return ok({ 12: 0.08 });
    if (path === "/api/v1/keys") return ok({ items: [{ id: 88, group_id: 12, status: "active" }], pages: 1 });
    if (path === "/api/v1/auth/me") return ok({ balance: 7.5, currency: "USD" });
    throw new Error(`Unexpected path: ${path}`);
  };
  const service = new MonitorService({
    config: normalizeConfig({ rolloutEnabled: false, managedKeyIds: [88], minimumConfidence: 0 }),
    dataDir: "unused",
    env: {},
    credentials: { email: "user@example.test", password: "secret" },
    credentialSource: "windows_dpapi_login",
    fetchImpl,
  });

  const state = await service.refresh({ autoRoute: false });
  assert.equal(state.runtime.auth.authenticated, true);
  assert.equal(state.config.credentialsValid, true);
  assert.equal(state.balance.amount, 7.5);
  assert.equal(state.currentGroupId, 12);
  assert.equal(calls.filter((call) => call.path === "/api/v1/auth/login").length, 1);
  assert.ok(calls.filter((call) => !call.path.endsWith("/login") && !call.path.includes("/public/")).every((call) => call.authorization === "Bearer session-access"));
  assert.equal(JSON.stringify(state).includes("session-access"), false);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});

test("invalid imported token leaves public stats available and reports one authentication error", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/public/groups/usage-stats") return ok({ items: [{ group_id: 7, code: "A007", rate_multiplier: 0.06, avg_ttft_ms: 1200, sample_count: 20, last_sample_at: new Date().toISOString() }] });
    return new Response(JSON.stringify({ code: 401, message: "Invalid token" }), { status: 200 });
  };
  const service = new MonitorService({
    config: normalizeConfig({ rolloutEnabled: false, minimumConfidence: 0 }),
    dataDir: "unused",
    env: {},
    credentials: { accessToken: "invalid" },
    credentialSource: "windows_dpapi_token",
    fetchImpl,
  });

  const state = await service.refresh({ autoRoute: false });
  assert.equal(state.runtime.auth.authenticated, false);
  assert.equal(state.providers.length, 1);
  assert.equal(state.runtime.lastError.length, 1);
  assert.equal(state.runtime.lastError[0].source, "authentication");
  assert.equal(state.runtime.lastError[0].message, "Invalid token");
});

test("expired login sessions refresh without asking for the password again", async () => {
  let loginCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/auth/login") {
      loginCalls += 1;
      return ok({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    }
    if (path === "/api/v1/auth/refresh") {
      refreshCalls += 1;
      assert.deepEqual(JSON.parse(options.body), { refresh_token: "refresh-1" });
      return ok({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    }
    if (path === "/api/v1/public/groups/usage-stats") return ok({ items: [] });
    if (path === "/api/v1/groups/available") return ok([]);
    if (path === "/api/v1/groups/rates") return ok({});
    if (path === "/api/v1/keys") return ok({ items: [], pages: 1 });
    if (path === "/api/v1/auth/me") return ok({});
    throw new Error(`Unexpected path: ${path}`);
  };
  const service = new MonitorService({
    config: normalizeConfig({ rolloutEnabled: false }),
    dataDir: "unused",
    env: {},
    credentials: { email: "user@example.test", password: "secret" },
    fetchImpl,
  });

  await service.refresh({ autoRoute: false });
  service.session.expiresAt = new Date(Date.now() - 1000).toISOString();
  await service.refresh({ autoRoute: false });
  assert.equal(loginCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(service.session.accessToken, "access-2");
});

test("transient provider and key fetch failures retain the last good snapshot", async () => {
  let fail = false;
  const fetchImpl = async (url) => {
    if (fail) throw new Error("fetch failed");
    const path = new URL(url).pathname;
    if (path === "/api/v1/public/groups/usage-stats") return ok({ items: [{ group_id: 12, code: "A012", rate_multiplier: 0.08, avg_ttft_ms: 500, sample_count: 100, last_sample_at: new Date().toISOString() }] });
    if (path === "/api/v1/groups/available") return ok([{ id: 12, name: "A012", status: "active", available: true, models: ["gpt-5.6-sol"] }]);
    if (path === "/api/v1/groups/rates") return ok({ 12: 0.08 });
    if (path === "/api/v1/keys") return ok({ items: [{ id: 88, group_id: 12, status: "active" }], pages: 1 });
    if (path === "/api/v1/auth/me") return ok({ balance: 7.5, currency: "USD" });
    throw new Error(`Unexpected path: ${path}`);
  };
  const service = new MonitorService({
    config: normalizeConfig({ rolloutEnabled: false, managedKeyIds: [88], minimumConfidence: 0 }),
    dataDir: "unused",
    env: {},
    credentials: { accessToken: "session-access" },
    fetchImpl,
  });

  const first = await service.refresh({ autoRoute: false });
  assert.equal(first.providers.length, 1);
  assert.equal(first.keys.length, 1);
  fail = true;
  const second = await service.refresh({ autoRoute: false });
  assert.equal(second.providers.length, 1);
  assert.equal(second.providers[0].models[0], "gpt-5.6-sol");
  assert.equal(second.keys.length, 1);
  assert.equal(second.runtime.providerDataStale, true);
  assert.equal(second.runtime.keyDataStale, true);
  assert.match(second.runtime.lastError.map((item) => item.message).join(" "), /fetch failed/);
});
