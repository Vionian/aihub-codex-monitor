import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RolloutCollector } from "../src/rollout-collector.mjs";

test("rollout collector calculates exact per-turn cumulative usage deltas", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aihub-rollout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout-test.jsonl");
  const lines = [
    { timestamp: "2026-08-20T00:00:00Z", type: "session_meta", payload: { id: "session-1", model_provider: "aihub" } },
    { timestamp: "2026-08-20T00:00:00Z", type: "session_meta", payload: { id: "parent-session", model_provider: "legacy", forked_from_id: "older-session" } },
    { timestamp: "2026-08-20T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
    { timestamp: "2026-08-20T00:00:02Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: 1787184002, model_context_window: 258400 } },
    { timestamp: "2026-08-20T00:00:02Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "xhigh" } },
    { timestamp: "2026-08-20T00:00:03Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 160, cached_input_tokens: 120, cache_write_input_tokens: 2, output_tokens: 35, reasoning_output_tokens: 11, total_tokens: 195 }, last_token_usage: { input_tokens: 145, cached_input_tokens: 110, output_tokens: 15, total_tokens: 160 } } } },
    { timestamp: "2026-08-20T00:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", started_at: 1787184002, completed_at: 1787184004, duration_ms: 2000, time_to_first_token_ms: 640 } },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const collector = new RolloutCollector({ roots: [root], historyFileLimit: 2 });
  const records = [];
  collector.on("record", (record) => records.push(record));
  await collector.start();
  collector.stop();
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, "session-1");
  assert.equal(records[0].modelProvider, "aihub");
  assert.equal(records[0].model, "gpt-5.6-sol");
  assert.equal(records[0].reasoningEffort, "xhigh");
  assert.equal(records[0].inputTokens, 60);
  assert.equal(records[0].cachedTokens, 40);
  assert.equal(records[0].cacheWriteTokens, 2);
  assert.equal(records[0].outputTokens, 15);
  assert.equal(records[0].reasoningTokens, 6);
  assert.equal(records[0].totalTokens, 75);
  assert.equal(records[0].contextTokens, 145);
  assert.equal(records[0].firstByteMs, 640);
  assert.equal(records[0].totalMs, 2000);
});
