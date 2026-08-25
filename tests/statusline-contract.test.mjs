import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("statusline keeps the compact row and exposes the requested monitor controls", async () => {
  const injector = await readFile(new URL("../statusline/injector.mjs", import.meta.url), "utf8");
  assert.match(injector, /height:21px/);
  assert.match(injector, /概览/);
  assert.match(injector, /分组与健康/);
  assert.match(injector, /经济/);
  assert.match(injector, /平衡/);
  assert.match(injector, /速度/);
  assert.match(injector, /缓存命中/);
  assert.match(injector, /可用率/);
  assert.match(injector, /模型检测/);
  assert.match(injector, /使用此分组/);
  assert.match(injector, /position:sticky;right:0/);
  assert.match(injector, /providerSignature/);
  assert.match(injector, /切换中/);
  assert.match(injector, /container-type:inline-size/);
  assert.match(injector, /@container \(max-width:880px\)/);
  assert.match(injector, /var VERSION = 9/);
  assert.match(injector, /relayAdapter === "generic"/);
  assert.match(injector, /var selected = document\.querySelector\('\[data-app-action-sidebar-thread-selected="true"\]'\);/);
  assert.match(injector, /var selectedFiber = idFromFiber\(selected\);/);
  assert.match(injector, /min-height:146px/);
  assert.match(injector, /font-size:12px;line-height:1.25/);
  assert.match(injector, /min-width:22px!important/);
  assert.match(injector, /grid-template-columns:repeat\(4,minmax\(0,1fr\)/);
  assert.match(injector, /\.aihub-table thead\{display:none\}/);
  assert.match(injector, /部分接口暂时不可达/);
  assert.match(injector, /余额/);
});

test("statusline launcher limits CDP to loopback and supervisor never restarts Codex", async () => {
  const [launcher, supervisor, startup, installer] = await Promise.all([
    readFile(new URL("../statusline/launch-statusline.ps1", import.meta.url), "utf8"),
    readFile(new URL("../statusline/watchdog.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-hidden.vbs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-autostart.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /--remote-debugging-address=127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /remote-allow-origins=\*/);
  assert.doesNotMatch(supervisor, /Stop-Process|taskkill/i);
  assert.match(supervisor, /statusline-supervisor\.log/);
  assert.match(startup, /shell\.Run command, 0, False/i);
  assert.match(installer, /start-hidden\.vbs/);
  assert.match(installer, /wscript\.exe/i);
  assert.match(installer, /temporaryShortcutPath/);
  assert.doesNotMatch(installer, /TargetPath = \$powershell/);
});
