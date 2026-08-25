import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, patchConfig, publicConfig, resolveDataDir } from "../src/config.mjs";

test("config accepts loopback URLs and rejects insecure remote URLs", () => {
  assert.equal(normalizeConfig({ aihubBaseUrl: "http://127.0.0.1:9000/v1" }).aihubBaseUrl, "http://127.0.0.1:9000");
  assert.equal(normalizeConfig({ aihubBaseUrl: "http://example.com" }).aihubBaseUrl, DEFAULT_CONFIG.aihubBaseUrl);
});

test("config supports generic relay pricing without enabling AIHub behavior", () => {
  const config = normalizeConfig({ relayAdapter: "generic", relayName: "Relay X", relayBaseUrl: "https://relay.example", relayMultiplier: 0.2, modelAliases: { "relay-model": "gpt-5.6-sol" } });
  assert.equal(config.relayAdapter, "generic");
  assert.equal(config.relayName, "Relay X");
  assert.equal(config.relayMultiplier, 0.2);
  assert.equal(config.modelAliases["relay-model"], "gpt-5.6-sol");
});

test("config patch ignores unknown and host override fields", () => {
  const config = patchConfig(DEFAULT_CONFIG, { mode: "speed", host: "0.0.0.0", unknown: "secret" });
  assert.equal(config.mode, "speed");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.unknown, undefined);
});

test("maximum multiplier never falls below the configured minimum", () => {
  const config = normalizeConfig({ minimumMultiplier: 0.5, maximumMultiplier: 0.1 });
  assert.equal(config.maximumMultiplier, 0.5);
});

test("public config reports credential presence without exposing it", () => {
  const result = publicConfig(DEFAULT_CONFIG, { AIHUB_ACCESS_TOKEN: "secret-token", AIHUB_CREDENTIAL_SOURCE: "windows_dpapi" });
  assert.equal(result.credentialsConfigured, true);
  assert.equal(result.credentialSource, "windows_dpapi");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.match(resolveDataDir({ AIHUB_MONITOR_DATA_DIR: "E:\\tmp\\monitor" }), /tmp[\\/]monitor$/);
});
