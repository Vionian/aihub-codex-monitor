import test from "node:test";
import assert from "node:assert/strict";
import { AIHubClient } from "../src/aihub-client.mjs";
import { normalizeConfig } from "../src/config.mjs";

test("AIHub client reads public stats, rates, keys and balance", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: parsed.search, method: options.method });
    const payloads = {
      "/api/v1/public/groups/usage-stats": { items: [{ group_id: 12, code: "A012", rate_multiplier: 0.08, avg_ttft_ms: 240, sample_count: 40, last_sample_at: "2026-08-20T00:00:00Z" }] },
      "/api/v1/groups/available": { data: [{ id: 12, name: "A012-Plus", available: true, models: ["gpt-5.6-sol"] }] },
      "/api/v1/groups/rates": { data: { "12": 0.08 } },
      "/api/v1/keys": { items: [{ id: 88, group_id: 12, enabled: true }] },
      "/api/v1/auth/me": { data: { balance: 12.34, currency: "USD" } },
    };
    return new Response(JSON.stringify(payloads[parsed.pathname] || {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new AIHubClient({ baseUrl: "https://aihub.top", accessToken: "test", fetchImpl });
  const snapshot = await client.refresh(normalizeConfig({ minimumConfidence: 0 }));
  assert.equal(snapshot.providers[0].name, "A012-Plus");
  assert.equal(snapshot.providers[0].multiplier, 0.08);
  assert.equal(snapshot.currentGroupId, 12);
  assert.equal(snapshot.balance.amount, 12.34);
  assert.ok(calls.some((call) => call.path === "/api/v1/public/groups/usage-stats"));
});

test("AIHub client updates a Key group with the documented endpoint", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), method: options.method, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 88, group_id: 12 }), { status: 200 });
  };
  const client = new AIHubClient({ baseUrl: "https://aihub.top", accessToken: "test", fetchImpl });
  await client.updateKeyGroup(88, 12);
  assert.equal(request.url, "https://aihub.top/api/v1/keys/88");
  assert.deepEqual(request.body, { group_id: 12 });
});

test("AIHub client logs in and refreshes the short-lived session", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, authorization: options.headers.authorization, body: JSON.parse(options.body) });
    if (path.endsWith("/login")) {
      return new Response(JSON.stringify({ code: 0, data: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { access_token: "access-2", expires_in: 1800 } }), { status: 200 });
  };
  const client = new AIHubClient({ baseUrl: "https://aihub.top", cookie: "cf_clearance=clear", userAgent: "Browser UA", fetchImpl });
  const login = await client.login("user@example.test", "password");
  const refreshed = await client.refreshSession(login.refreshToken);
  assert.equal(login.accessToken, "access-1");
  assert.equal(refreshed.accessToken, "access-2");
  assert.equal(refreshed.refreshToken, "refresh-1");
  assert.equal(requests[0].authorization, undefined);
  assert.deepEqual(requests[0].body, { email: "user@example.test", password: "password" });
  assert.deepEqual(requests[1].body, { refresh_token: "refresh-1" });
});

test("AIHub client reports API-level invalid token responses as authentication failures", async () => {
  const client = new AIHubClient({
    baseUrl: "https://aihub.top",
    accessToken: "invalid",
    fetchImpl: async () => new Response(JSON.stringify({ code: 401, message: "Invalid token" }), { status: 200 }),
  });
  await assert.rejects(() => client.validateLogin(), (error) => error.authenticationFailure === true && error.message === "Invalid token");
});

test("missing public health fields remain unknown instead of becoming zero", async () => {
  const client = new AIHubClient({
    baseUrl: "https://aihub.top",
    fetchImpl: async () => new Response(JSON.stringify({ data: { items: [{ group_id: 7, code: "A007", rate_multiplier: 0.06, avg_ttft_ms: 1200, sample_count: 20, last_sample_at: new Date().toISOString() }] } }), { status: 200 }),
  });
  const snapshot = await client.refresh(normalizeConfig({ minimumConfidence: 0 }), { includePrivate: false });
  assert.equal(snapshot.providers[0].cacheHitRate, null);
  assert.equal(snapshot.providers[0].successRate, null);
  assert.equal(snapshot.providers[0].available, null);
  assert.equal(snapshot.providers[0].status, "observed");
});
