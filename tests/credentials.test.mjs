import test from "node:test";
import assert from "node:assert/strict";
import { credentialsConfigured, loadCredentials, parseStoredCredential } from "../src/credentials.mjs";

test("credential loader prefers the process environment without exposing it in metadata", async () => {
  const result = await loadCredentials({ env: { AIHUB_ACCESS_TOKEN: "  secret-token  " }, dataDir: "unused" });
  assert.equal(result.credentials.accessToken, "secret-token");
  assert.equal(result.source, "environment_token");
  assert.equal(result.error, null);
});

test("structured login credentials and legacy token payloads are both supported", () => {
  const login = parseStoredCredential(JSON.stringify({ email: " user@example.test ", password: "secret", cookie: "cf_clearance=x" }));
  assert.equal(login.email, "user@example.test");
  assert.equal(login.password, "secret");
  assert.equal(credentialsConfigured(login), true);

  const legacy = parseStoredCredential("legacy-access-token");
  assert.equal(legacy.accessToken, "legacy-access-token");
});
