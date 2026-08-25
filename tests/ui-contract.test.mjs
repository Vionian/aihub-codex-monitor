import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard script only references element IDs present in the HTML shell", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../assets/index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const scriptIds = new Set([...script.matchAll(/\$\("#([a-z0-9-]+)"\)/g)].map((match) => match[1]));
  const missing = [...scriptIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
  assert.match(html, /正在连接本地监控服务/);
  assert.match(html, /等待第一个 Codex 请求/);
  assert.match(script, /healthLabel/);
  assert.match(script, /AIHub 公共 TTFT/);
  assert.match(script, /接口未提供/);
});
