#!/usr/bin/env node

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUESTED_CDP_PORT = Number(process.env.AIHUB_STATUSLINE_CDP_PORT || 0);
const MONITOR_PORT = Number(process.env.AIHUB_MONITOR_PORT || 48160);
const STATUSLINE_PORT = Number(process.env.AIHUB_STATUSLINE_HEALTH_PORT || 48161);
const POLL_MS = 1500;
const API = `http://127.0.0.1:${MONITOR_PORT}`;

async function cdpProbe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function discoverCdpPort() {
  const ports = [];
  if (REQUESTED_CDP_PORT > 0) ports.push(REQUESTED_CDP_PORT);
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\").CommandLine",
      ], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true });
      for (const match of String(stdout).matchAll(/--remote-debugging-port=(\d+)/gi)) ports.push(Number(match[1]));
    } catch { /* Access can be denied for packaged Codex processes. */ }
  }
  ports.push(9347, 9224, 9222);
  const unique = [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port < 65536))];
  for (const port of unique) if (await cdpProbe(port)) return port;
  return unique[0] || 9347;
}

let activeCdpPort = await discoverCdpPort();

const INSTALL_SCRIPT = String.raw`
(function () {
  var VERSION = 9;
  var CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (window.__aihubStatuslineInstalled && window.__aihubStatuslineVersion === VERSION) {
    try { window.__aihubStatuslineEnsure && window.__aihubStatuslineEnsure(); } catch (e) {}
    return;
  }
  var old = document.getElementById("aihub-statusline");
  if (old) old.remove();
  var oldStyle = document.getElementById("aihub-statusline-style");
  if (oldStyle) oldStyle.remove();
  window.__aihubStatuslineInstalled = true;
  window.__aihubStatuslineVersion = VERSION;
  window.__aihubStatuslineActions = [];

  function fiberOf(el) {
    if (!el) return null;
    for (var key in el) if (key.indexOf("__reactFiber$") === 0) return el[key];
    return null;
  }
  function idFromFiber(start) {
    var fiber = fiberOf(start), depth = 0;
    while (fiber && depth++ < 140) {
      var bags = [fiber.memoizedProps, fiber.memoizedState];
      for (var b = 0; b < bags.length; b++) {
        var bag = bags[b];
        if (!bag || typeof bag !== "object") continue;
        for (var key in bag) {
          if (key === "conversationId" || /[Cc]onversationId$/.test(key)) {
            var value = bag[key];
            if (typeof value === "string" && CONV_RE.test(value)) return value;
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }
  function sidebarId() {
    var selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    if (!selected) return null;
    var raw = selected.getAttribute("data-app-action-sidebar-thread-id") || "";
    var value = raw.replace(/^local:/, "");
    return CONV_RE.test(value) ? value : null;
  }
  function composerHost() {
    var editor = document.querySelector(".ProseMirror");
    if (editor) {
      var form = editor.closest("form");
      if (form) return form;
      var parent = editor.parentElement;
      for (var i = 0; parent && i < 8; i++, parent = parent.parentElement) {
        if (parent.querySelector && parent.querySelector("button[class*='size-token-button-compose']")) return parent;
      }
    }
    var send = document.querySelector("button[class*='size-token-button-compose']");
    return send ? (send.closest("form") || send.parentElement) : null;
  }
  function currentId() {
    var selected = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    var sidebar = sidebarId();
    var editor = document.querySelector(".ProseMirror");
    // New desktop threads use a client-generated sidebar key, while the
    // selected row's React fiber still carries the rollout conversation ID.
    var selectedFiber = idFromFiber(selected);
    var editorFiber = idFromFiber(editor);
    if (selectedFiber) return selectedFiber;
    if (sidebar && editorFiber) return sidebar === editorFiber ? sidebar : null;
    return sidebar || editorFiber || null;
  }
  function contextUsage() {
    var ring = document.querySelector('[aria-label^="Context usage:"]');
    var fiber = fiberOf(ring), depth = 0;
    while (fiber && depth++ < 30) {
      var bags = [fiber.memoizedProps, fiber.memoizedState];
      for (var b = 0; b < bags.length; b++) {
        var bag = bags[b];
        if (!bag || typeof bag !== "object") continue;
        for (var key in bag) {
          var value = bag[key];
          if (value && typeof value === "object" && typeof value.usedTokens === "number" && typeof value.contextWindow === "number") return value;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }
  function byId(id) { return document.getElementById(id); }
  function setText(id, value) { var node = byId(id); if (node) node.textContent = value == null ? "--" : String(value); }
  function queue(type, payload) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    window.__aihubStatuslineActions.push({ id: id, type: type, payload: payload || {} });
    return id;
  }
  function toast(message, isError) {
    var node = byId("aihub-drawer-toast");
    if (!node) return;
    node.textContent = String(message || "");
    node.classList.toggle("is-error", !!isError);
    node.classList.add("is-visible");
    clearTimeout(window.__aihubToastTimer);
    window.__aihubToastTimer = setTimeout(function () { node.classList.remove("is-visible"); }, 3000);
  }
  function showView(view) {
    document.querySelectorAll("#aihub-statusline [data-aihub-view]").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-aihub-view") === view);
    });
    document.querySelectorAll("#aihub-statusline .aihub-drawer-view").forEach(function (panel) {
      panel.hidden = panel.id !== "aihub-view-" + view;
    });
  }
  function toggleDrawer(force) {
    var drawer = byId("aihub-monitor-drawer");
    var toggle = byId("aihub-statusline-toggle");
    if (!drawer) return;
    var open = typeof force === "boolean" ? force : drawer.hidden;
    drawer.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
  }
  function ensureStyle() {
    if (byId("aihub-statusline-style")) return;
    var style = document.createElement("style");
    style.id = "aihub-statusline-style";
    style.textContent =
      "#aihub-statusline{display:block;box-sizing:border-box;width:100%;container-type:inline-size;font:12px/1.35 'Segoe UI','Microsoft YaHei',sans-serif;color:#a7adb5;background:transparent;user-select:none;position:relative;z-index:20}" +
      "#aihub-statusline-row{box-sizing:border-box;height:21px;display:flex;align-items:center;width:100%;padding:0 5px 0 13px;border-bottom:1px solid rgba(128,128,128,.28);font-family:Consolas,monospace;cursor:pointer}" +
      "#aihub-statusline-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}" +
      "#aihub-statusline #aihub-statusline-toggle,#aihub-statusline .aihub-icon-button{width:22px!important;height:20px!important;min-width:22px!important;min-height:20px!important;display:grid;place-items:center;padding:0;border:0!important;background:transparent;color:#9299a2;font-size:15px;cursor:pointer;box-shadow:none!important}" +
      "#aihub-statusline-toggle:hover,.aihub-icon-button:hover{color:#edf1f3;background:rgba(127,127,127,.12)}" +
      "#aihub-statusline.aihub-offline #aihub-statusline-row{opacity:.62}" +
      "#aihub-statusline.aihub-fixed{position:fixed;left:0;right:0;bottom:96px}" +
      "#aihub-monitor-drawer{box-sizing:border-box;width:100%;max-height:min(430px,52vh);overflow:auto;background:#131619;border:1px solid #343a40;border-bottom:0;color:#edf1f3;box-shadow:0 -10px 28px rgba(0,0,0,.28);user-select:text}" +
      "#aihub-monitor-drawer[hidden]{display:none!important}" +
      ".aihub-drawer-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 10px;background:#181c1f;border-bottom:1px solid #343a40}" +
      ".aihub-drawer-brand{font-weight:700;color:#f1f4f5}.aihub-drawer-brand small{display:block;font-size:9px;font-weight:400;color:#89929a}" +
      ".aihub-drawer-spacer{flex:1}.aihub-badge{padding:2px 6px;border:1px solid #3c444b;border-radius:3px;color:#aab2b9;font-size:10px;white-space:nowrap}" +
      ".aihub-badge.good{border-color:#347961;color:#55d8aa}.aihub-badge.warn{border-color:#846b37;color:#e5b862}.aihub-badge.bad{border-color:#8a4646;color:#ef8585}" +
      ".aihub-drawer-status{display:flex;align-items:center;gap:7px;min-height:31px;padding:5px 10px;background:#15191c;border-bottom:1px solid #2d3338;color:#9ca4ab}" +
      ".aihub-status-dot{width:7px;height:7px;border-radius:50%;background:#e5b862}.aihub-status-dot.good{background:#55d8aa}.aihub-status-dot.bad{background:#ef8585}" +
      ".aihub-drawer-tabs{display:flex;border-bottom:1px solid #343a40;background:#111416}" +
      ".aihub-drawer-tabs button{height:30px;padding:0 11px;border:0;border-bottom:2px solid transparent;background:transparent;color:#929ba2;font:11px 'Segoe UI','Microsoft YaHei',sans-serif;cursor:pointer}" +
      ".aihub-drawer-tabs button.is-active{color:#edf1f3;border-bottom-color:#58bdd7}" +
      ".aihub-drawer-view{padding:10px}.aihub-drawer-view[hidden]{display:none!important}" +
      ".aihub-live-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #343a40}" +
      ".aihub-live-metric{min-height:51px;padding:7px 9px;border-right:1px solid #343a40;background:#191d20}.aihub-live-metric:last-child{border-right:0}" +
      ".aihub-live-metric span{display:block;color:#89929a;font-size:9px}.aihub-live-metric strong{display:block;margin-top:2px;color:#edf1f3;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".aihub-route-row{display:flex;align-items:center;gap:9px;margin-top:9px;padding:8px 9px;background:#191d20;border:1px solid #343a40}" +
      ".aihub-route-copy{min-width:0;flex:1}.aihub-route-copy strong,.aihub-route-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aihub-route-copy small{color:#89929a}" +
      ".aihub-segmented{display:inline-flex;border:1px solid #3a4248;border-radius:3px;overflow:hidden}" +
      ".aihub-segmented button{height:25px;padding:0 8px;border:0;border-right:1px solid #3a4248;background:#111416;color:#9aa2a9;font-size:10px;cursor:pointer}.aihub-segmented button:last-child{border-right:0}.aihub-segmented button.is-active{background:#55d8aa;color:#07140f}" +
      ".aihub-request-line{margin-top:9px;padding:7px 9px;border-left:2px solid #58bdd7;background:#191d20;color:#a8b0b6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".aihub-table-scroll{overflow:auto;border:1px solid #343a40}.aihub-table{width:100%;min-width:920px;border-collapse:collapse;background:#181c1f;font-size:10px}" +
      ".aihub-table th,.aihub-table td{padding:6px 7px;border-bottom:1px solid #30363b;text-align:left;vertical-align:middle;white-space:nowrap}.aihub-table th{position:sticky;top:0;background:#111416;color:#89929a;font-weight:500}.aihub-table tr:last-child td{border-bottom:0}.aihub-table tr.active{background:rgba(85,216,170,.07)}.aihub-table th:last-child,.aihub-table td:last-child{position:sticky;right:0;z-index:1;min-width:112px;width:112px;background:#181c1f;box-shadow:-5px 0 8px rgba(0,0,0,.2)}.aihub-table th:last-child{z-index:3;background:#111416}.aihub-table tr.active td:last-child{background:#1a2924}" +
      ".aihub-table td small{display:block;color:#89929a}.aihub-model-tags{display:flex;gap:3px;margin-top:3px}.aihub-model-tag{padding:1px 4px;border:1px solid #38515a;border-radius:3px;color:#58bdd7;font:9px/1.35 Consolas,monospace}.aihub-health-badge{display:inline-block;padding:2px 5px;border-radius:3px;background:#263036;color:#58bdd7;font-size:9px}.aihub-health-badge.good{background:#55d8aa;color:#062218}.aihub-health-badge.warn{background:#e5b862;color:#2b1b06}.aihub-health-badge.bad{background:#ef8585;color:#2b0a0a}.aihub-sparkline{display:flex;align-items:end;gap:2px;height:15px;margin-top:4px}.aihub-sparkline i{display:block;width:3px;min-height:2px;background:#58bdd7;opacity:.72}.aihub-switch{height:23px;padding:0 7px;border:1px solid #347961;border-radius:3px;background:#14231e;color:#55d8aa;font-size:10px;cursor:pointer;white-space:nowrap}.aihub-switch:disabled{opacity:.42;cursor:not-allowed}" +
      ".aihub-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.aihub-settings label{display:grid;gap:4px;color:#929ba2;font-size:10px}.aihub-settings input[type=text],.aihub-settings input[type=number]{height:28px;padding:4px 7px;border:1px solid #3a4248;background:#111416;color:#edf1f3;outline:none}.aihub-settings input:focus{border-color:#58bdd7}.aihub-toggle{display:flex!important;align-items:center;gap:7px;min-height:28px}.aihub-settings-actions{grid-column:1/-1;display:flex;align-items:center;gap:8px}" +
      ".aihub-primary{height:27px;padding:0 10px;border:0;border-radius:3px;background:#58bdd7;color:#061016;font-weight:700;cursor:pointer}.aihub-settings-note{color:#89929a;font-size:10px}" +
      "#aihub-drawer-toast{position:sticky;bottom:8px;float:right;max-width:75%;margin:0 8px 8px;padding:6px 9px;border:1px solid #347961;background:#17231f;color:#55d8aa;opacity:0;pointer-events:none;transform:translateY(4px);transition:.15s}#aihub-drawer-toast.is-visible{opacity:1;transform:none}#aihub-drawer-toast.is-error{border-color:#8a4646;background:#281a1a;color:#ef8585}" +
      "@container (max-width:880px){.aihub-table-scroll{overflow-x:hidden}.aihub-table{display:block;min-width:0;width:100%;font-size:10px}.aihub-table thead{display:none}.aihub-table tbody{display:block}.aihub-table tr{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0 6px;padding:7px 6px;border-bottom:1px solid #30363b;background:#181c1f}.aihub-table tr.active{background:rgba(85,216,170,.07)}.aihub-table td,.aihub-table td:last-child{position:static;display:block;width:auto;min-width:0;padding:4px 3px;border:0;box-shadow:none;white-space:normal;overflow-wrap:anywhere}.aihub-table td:nth-child(1){grid-column:1 / 3;grid-row:1}.aihub-table td:nth-child(2){grid-column:3;grid-row:1}.aihub-table td:nth-child(8){grid-column:4;grid-row:1 / 3}.aihub-table td:nth-child(3){grid-column:1 / 4;grid-row:2;min-height:28px}.aihub-table td:nth-child(4){grid-column:1;grid-row:3}.aihub-table td:nth-child(5){grid-column:2;grid-row:3}.aihub-table td:nth-child(6){grid-column:3;grid-row:3}.aihub-table td:nth-child(7){grid-column:4;grid-row:3}.aihub-table td:nth-child(n+4):nth-child(-n+7)::before{content:attr(data-label);display:block;margin-bottom:2px;color:#737d85;font-size:8px;line-height:1.2}.aihub-table td strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aihub-table td small{line-height:1.25;white-space:normal}.aihub-table .aihub-health-badge{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aihub-switch{width:100%;height:auto;min-height:26px;padding:4px 2px;white-space:normal;font-size:10px}.aihub-table td:last-child small{max-height:3.8em;overflow:hidden}.aihub-sparkline{height:11px;margin-top:3px}.aihub-sparkline i{width:2px}}" +
      "@container (max-width:880px){.aihub-drawer-head{min-height:44px;padding:8px 12px;gap:9px}.aihub-drawer-brand{font-size:13px}.aihub-drawer-brand small{font-size:9px}.aihub-badge{padding:3px 7px;font-size:10px}.aihub-drawer-status{min-height:35px;padding:7px 12px;font-size:11px}.aihub-drawer-tabs button{height:34px!important;min-height:34px!important;padding:0 13px;font-size:12px;border:0!important}.aihub-drawer-view{padding:12px}.aihub-table{font-size:11px}.aihub-table tr{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) minmax(122px,1.25fr);column-gap:9px;padding:10px 10px 11px;min-height:146px}.aihub-table td,.aihub-table td:last-child{padding:5px 2px}.aihub-table td:nth-child(3){min-height:38px}.aihub-table td:nth-child(n+4):nth-child(-n+7)::before{font-size:9px;margin-bottom:3px}.aihub-table td strong{font-size:12px;line-height:1.25}.aihub-table td small{font-size:9px;line-height:1.35;color:#9aa4ac}.aihub-health-badge{font-size:10px;padding:3px 6px}.aihub-switch{font-size:11px;min-height:30px;padding:5px 4px}.aihub-table td:last-child small{font-size:9px;line-height:1.3;max-height:4.2em;margin-top:5px}.aihub-sparkline{height:12px;margin-top:4px}}" +
      "@media(max-width:620px){.aihub-live-grid{grid-template-columns:repeat(2,1fr)}.aihub-live-metric:nth-child(2){border-right:0}.aihub-settings{grid-template-columns:1fr}.aihub-settings-actions{grid-column:auto}.aihub-route-row{align-items:flex-start;flex-direction:column}}";
    (document.head || document.documentElement).appendChild(style);
  }
  function buildRoot() {
    var root = document.createElement("div");
    root.id = "aihub-statusline";
    root.innerHTML =
      '<section id="aihub-monitor-drawer" hidden aria-label="AIHub Codex Monitor">' +
        '<header class="aihub-drawer-head"><div class="aihub-drawer-brand">AIHub Codex Monitor<small>LOCAL CONTROL PLANE</small></div><span id="aihub-auth-badge" class="aihub-badge warn">未登录</span><span id="aihub-balance-badge" class="aihub-badge">余额 --</span><span class="aihub-drawer-spacer"></span><button id="aihub-refresh" class="aihub-icon-button" title="刷新供应商数据" aria-label="刷新供应商数据">↻</button><button id="aihub-close" class="aihub-icon-button" title="关闭监控抽屉" aria-label="关闭监控抽屉">×</button></header>' +
        '<div class="aihub-drawer-status"><span id="aihub-system-dot" class="aihub-status-dot"></span><span id="aihub-system-text">正在连接本地监控服务</span><span class="aihub-drawer-spacer"></span><span id="aihub-source-badge" class="aihub-badge">ROLLOUT</span></div>' +
        '<nav class="aihub-drawer-tabs" aria-label="监控视图"><button data-aihub-view="overview" class="is-active">概览</button><button data-aihub-view="providers">分组与健康</button><button data-aihub-view="settings">设置</button></nav>' +
        '<div id="aihub-view-overview" class="aihub-drawer-view"><div class="aihub-live-grid"><div class="aihub-live-metric"><span>模型 / 推理</span><strong id="aihub-live-model">--</strong></div><div class="aihub-live-metric"><span>Token 输入 / 输出</span><strong id="aihub-live-tokens">--</strong></div><div class="aihub-live-metric"><span>首字 / 总耗时</span><strong id="aihub-live-latency">--</strong></div><div class="aihub-live-metric"><span>费用</span><strong id="aihub-live-cost">--</strong></div></div><div class="aihub-route-row"><div class="aihub-route-copy"><strong id="aihub-route-name">等待路由数据</strong><small id="aihub-route-reason">--</small></div><div class="aihub-segmented" aria-label="路由模式"><button data-aihub-mode="economy">经济</button><button data-aihub-mode="balanced">平衡</button><button data-aihub-mode="speed">速度</button></div></div><div id="aihub-recent-request" class="aihub-request-line">等待当前会话的第一个请求</div></div>' +
        '<div id="aihub-view-providers" class="aihub-drawer-view" hidden><div class="aihub-table-scroll"><table class="aihub-table"><thead><tr><th>分组</th><th>倍率 ↑</th><th>状态 / 模型</th><th>用户速度</th><th>缓存命中</th><th>可用率</th><th>模型检测</th><th>使用分组</th></tr></thead><tbody id="aihub-provider-rows"><tr><td colspan="8">等待供应商数据</td></tr></tbody></table></div></div>' +
        '<div id="aihub-view-settings" class="aihub-drawer-view" hidden><div class="aihub-settings"><label>管理 Key ID（逗号分隔）<input id="aihub-managed-keys" type="text" autocomplete="off" placeholder="例如 12, 18"></label><label>最高倍率<input id="aihub-max-multiplier" type="number" min="0" step="0.01"></label><label class="aihub-toggle"><input id="aihub-routing-enabled" type="checkbox">启用自动路由</label><label class="aihub-toggle"><input id="aihub-failover-enabled" type="checkbox">启用错误切组</label><div class="aihub-settings-actions"><button id="aihub-save-settings" class="aihub-primary">保存设置</button><span id="aihub-credential-note" class="aihub-settings-note">尚未登录 AIHub</span></div></div></div>' +
        '<div id="aihub-drawer-toast"></div>' +
      '</section>' +
      '<div id="aihub-statusline-row" title="打开 AIHub 监控"><span id="aihub-statusline-text">AIHub · 等待 Codex 请求…</span><button id="aihub-statusline-toggle" title="展开 AIHub 监控" aria-label="展开 AIHub 监控" aria-expanded="false">⋯</button></div>';
    root.querySelector("#aihub-statusline-row").addEventListener("click", function () { toggleDrawer(); });
    root.querySelector("#aihub-close").addEventListener("click", function (event) { event.stopPropagation(); toggleDrawer(false); });
    root.querySelector("#aihub-refresh").addEventListener("click", function () { queue("refresh"); toast("正在刷新…", false); });
    root.querySelectorAll("[data-aihub-view]").forEach(function (button) { button.addEventListener("click", function () { showView(button.getAttribute("data-aihub-view")); }); });
    root.querySelectorAll("[data-aihub-mode]").forEach(function (button) { button.addEventListener("click", function () { queue("mode", { mode: button.getAttribute("data-aihub-mode") }); toast("正在更新路由模式…", false); }); });
    root.querySelector("#aihub-save-settings").addEventListener("click", function () {
      var ids = byId("aihub-managed-keys").value.split(",").map(function (value) { return Number(value.trim()); }).filter(function (value) { return Number.isSafeInteger(value) && value > 0; });
      queue("configure", { managedKeyIds: ids, maximumMultiplier: Number(byId("aihub-max-multiplier").value), routingEnabled: byId("aihub-routing-enabled").checked, failoverEnabled: byId("aihub-failover-enabled").checked });
      toast("正在保存…", false);
    });
    return root;
  }
  function ensure() {
    ensureStyle();
    var root = byId("aihub-statusline") || buildRoot();
    var editor = document.querySelector(".ProseMirror");
    if (!editor) { root.style.display = "none"; return; }
    root.style.display = "";
    var host = composerHost();
    if (host && host.parentNode) {
      var parent = host.parentNode;
      if (root.parentNode !== parent || root.nextSibling !== host) parent.insertBefore(root, host);
      root.classList.remove("aihub-fixed");
      root.style.position = ""; root.style.left = ""; root.style.right = ""; root.style.bottom = "";
    } else {
      root.classList.add("aihub-fixed");
      if (!document.body.contains(root)) document.body.appendChild(root);
    }
  }
  function renderModel(model) {
    if (!model) return;
    var auth = byId("aihub-auth-badge");
    if (auth) { auth.textContent = model.authText; auth.className = "aihub-badge " + (model.authenticated ? "good" : "warn"); }
    setText("aihub-balance-badge", "余额 " + model.balanceText);
    setText("aihub-system-text", model.systemText);
    var dot = byId("aihub-system-dot");
    if (dot) dot.className = "aihub-status-dot " + (model.systemLevel || "");
    setText("aihub-source-badge", model.sourceText);
    setText("aihub-live-model", model.request.modelEffort);
    setText("aihub-live-tokens", model.request.tokens);
    setText("aihub-live-latency", model.request.latency);
    setText("aihub-live-cost", model.request.cost);
    var liveCost = byId("aihub-live-cost");
    if (liveCost) liveCost.title = model.request.costDetail || "";
    setText("aihub-route-name", model.routeName);
    setText("aihub-route-reason", model.routeReason);
    setText("aihub-recent-request", model.request.detail);
    document.querySelectorAll("#aihub-statusline [data-aihub-mode]").forEach(function (button) { button.hidden = model.routing === false; button.classList.toggle("is-active", button.getAttribute("data-aihub-mode") === model.mode); });
    var keys = byId("aihub-managed-keys");
    if (keys && document.activeElement !== keys) keys.value = (model.settings.managedKeyIds || []).join(", ");
    var multiplier = byId("aihub-max-multiplier");
    if (multiplier && document.activeElement !== multiplier) multiplier.value = model.settings.maximumMultiplier == null ? "" : String(model.settings.maximumMultiplier);
    var routingToggle = byId("aihub-routing-enabled");
    var failoverToggle = byId("aihub-failover-enabled");
    if (routingToggle) routingToggle.checked = model.settings.routingEnabled !== false;
    if (failoverToggle) failoverToggle.checked = model.settings.failoverEnabled !== false;
    setText("aihub-credential-note", model.credentialNote);
    var rows = byId("aihub-provider-rows");
    var providerSignature = JSON.stringify((model.providers || []).map(function (provider) { return [provider.id, provider.status, provider.healthClass, provider.models, provider.speed, provider.cacheHit, provider.availability, provider.modelCheck, provider.switchable, provider.active, provider.switchReason]; }));
    if (rows && window.__aihubStatuslineProviderSignature !== providerSignature) {
      window.__aihubStatuslineProviderSignature = providerSignature;
      rows.textContent = "";
      if (!model.providers.length) {
        var empty = document.createElement("tr"), cell = document.createElement("td");
        cell.colSpan = 8; cell.textContent = "等待供应商数据"; empty.appendChild(cell); rows.appendChild(empty);
      }
      model.providers.forEach(function (provider) {
        var row = document.createElement("tr");
        if (provider.active) row.className = "active";
        function cell(primary, secondary) { var td = document.createElement("td"), strong = document.createElement("strong"); strong.textContent = primary; td.appendChild(strong); if (secondary) { var small = document.createElement("small"); small.textContent = secondary; td.appendChild(small); } return td; }
        function badgeCell(label, badgeClass, secondary) { var td = document.createElement("td"), badge = document.createElement("span"); badge.className = "aihub-health-badge " + (badgeClass || ""); badge.textContent = label; td.appendChild(badge); if (secondary) { var small = document.createElement("small"); small.textContent = secondary; td.appendChild(small); } return td; }
        row.appendChild(cell(provider.name, provider.code));
        row.appendChild(cell(provider.multiplier, ""));
        row.appendChild(badgeCell(provider.status, provider.healthClass, provider.models + " · " + provider.healthDetail + " · " + provider.freshness));
        var speedCell = cell(provider.speed, provider.speedSource); if (provider.trend && provider.trend.length) { var spark = document.createElement("span"); spark.className = "aihub-sparkline"; var values = provider.trend.map(function (point) { return Number(point.ttftMs); }).filter(Number.isFinite); var max = values.length ? Math.max.apply(Math, values) : 0; values.slice(-12).forEach(function (value) { var bar = document.createElement("i"); bar.style.height = Math.max(12, Math.round((value / max) * 100)) + "%"; spark.appendChild(bar); }); speedCell.appendChild(spark); } row.appendChild(speedCell);
        row.appendChild(cell(provider.cacheHit, provider.cacheSource));
        row.appendChild(cell(provider.availability, provider.availabilitySource));
        row.appendChild(badgeCell(provider.modelCheck, provider.modelClass, provider.modelSource));
        var action = document.createElement("td"), button = document.createElement("button");
        button.className = "aihub-switch"; button.textContent = provider.active ? "当前使用" : "使用此分组"; button.disabled = !provider.switchable;
        button.title = provider.switchReason || "切换到此分组";
        var actionNote = document.createElement("small"); actionNote.textContent = provider.active ? "当前请求将使用此组" : provider.switchReason || "不可切换";
        button.addEventListener("click", function () { if (button.dataset.switching === "true") return; button.disabled = true; button.dataset.switching = "true"; button.textContent = "切换中…"; var actionId = queue("switch", { groupId: provider.id }); button.dataset.actionId = actionId; toast("正在切换分组…", false); });
        action.appendChild(button); action.appendChild(actionNote); row.appendChild(action);
        ["分组", "倍率", "状态 / 模型", "用户速度", "缓存命中", "可用率", "模型检测", "使用分组"].forEach(function (label, index) { if (row.children[index]) row.children[index].setAttribute("data-label", label); });
        rows.appendChild(row);
      });
    }
  }
  window.__aihubStatuslineEnsure = ensure;
  window.__aihubStatuslineRead = function () { return { convId: currentId(), context: contextUsage(), actions: window.__aihubStatuslineActions.splice(0) }; };
  window.__aihubStatuslineUpdate = function (text, convId, offline, model) {
    var actual = currentId();
    if (convId && actual && convId !== actual) return;
    ensure();
    var target = byId("aihub-statusline-text");
    if (target && target.textContent !== String(text)) target.textContent = String(text);
    var root = byId("aihub-statusline");
    if (root) root.classList.toggle("aihub-offline", !!offline);
    renderModel(model);
  };
  window.__aihubStatuslineActionResult = function (id, ok, message) { var button = document.querySelector('#aihub-provider-rows button[data-action-id="' + id + '"]'); if (button && !ok) { button.disabled = false; button.dataset.switching = "false"; button.removeAttribute("data-action-id"); button.textContent = "使用此分组"; } toast(message || (ok ? "操作完成" : "操作失败"), !ok); };
  window.__aihubStatuslineInspect = function () {
    var root = byId("aihub-statusline"), row = byId("aihub-statusline-row"), drawer = byId("aihub-monitor-drawer");
    var rect = row ? row.getBoundingClientRect() : null;
    return { installed: !!root, visible: !!(root && row && getComputedStyle(root).display !== "none" && rect && rect.width > 0 && rect.height > 0), position: root && root.classList.contains("aihub-fixed") ? "fixed-fallback" : "above-composer", height: rect ? Math.round(rect.height) : 0, text: byId("aihub-statusline-text") ? byId("aihub-statusline-text").textContent : "", drawerOpen: !!(drawer && !drawer.hidden) };
  };
  ensure();
  if (!window.__aihubStatuslineObserver) {
    var pending = false;
    window.__aihubStatuslineObserver = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || function (callback) { setTimeout(callback, 50); })(function () { pending = false; try { ensure(); } catch (e) {} });
    });
    window.__aihubStatuslineObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;

let apiState = null;
let apiStateAt = 0;

async function apiCall(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* Use the HTTP status below. */ }
  if (!response.ok) throw new Error(payload?.error || `Monitor returned ${response.status}`);
  return payload;
}

async function getApiState() {
  if (apiState && Date.now() - apiStateAt < 1000) return apiState;
  try {
    apiState = await apiCall("/api/state");
    apiStateAt = Date.now();
  } catch {
    apiState = null;
  }
  return apiState;
}

function compact(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 100_000) return `${Math.round(number / 1_000)}k`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(Math.round(number));
}

function money(value, currency = "USD") {
  const number = Number(value);
  return Number.isFinite(number) ? `${currency === "USD" ? "$" : `${currency} `}${number.toFixed(6)}` : "--";
}

function uncachedInput(record) {
  const input = Math.max(0, Number(record?.inputTokens) || 0);
  return input - Math.min(input, Math.max(0, Number(record?.cachedTokens) || 0));
}

function costDetail(record) {
  const detail = record?.costBreakdown;
  if (!detail) return record?.costSource === "balance_delta" ? "AIHub 余额扣款归因" : ["upstream_header", "upstream_body"].includes(record?.costSource) ? "AIHub 返回的真实费用" : "";
  const currency = record?.relayCurrency || "USD";
  return `输入 ${money(detail.inputCost, currency)} + 输出 ${money(detail.outputCost, currency)} + 缓存 ${money(detail.cachedInputCost, currency)} = 原始 ${money(detail.originalCost, currency)} × ${Number(detail.multiplier).toFixed(2)}x`;
}

function milliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number >= 1000 ? `${(number / 1000).toFixed(2)}s` : `${Math.round(number)}ms`;
}

function liveDuration(record) {
  if (record?.state !== "running" || !record.startedAt) return record?.totalMs;
  const started = Date.parse(record.startedAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : record.totalMs;
}

function percent(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${Math.round(number * 1000) / 10}%`;
}

function recordFor(state, convId) {
  if (!state || !convId) return null;
  const requests = state.telemetry?.requests || [];
  if (state.currentTurn?.sessionId === convId) {
    const turn = state.currentTurn;
    const turnStarted = Date.parse(turn.startedAt || "");
    const billed = requests.find((item) => item.model === turn.model && item.cost !== null && item.cost !== undefined
      && (!Number.isFinite(turnStarted) || !Number.isFinite(Date.parse(item.startedAt || "")) || Date.parse(item.startedAt) >= turnStarted - 5000));
    const observed = billed
      || requests.find((item) => item.sessionId === convId)
      || requests.find((item) => item.model === turn.model && item.cost !== null && item.cost !== undefined)
      || requests.find((item) => item.model === turn.model);
    if (observed && (billed || (!Number(turn.inputTokens) && !Number(turn.outputTokens) && (Number(observed.inputTokens) || Number(observed.outputTokens) || observed.cost != null)))) {
      return { ...observed, ...turn, inputTokens: Number(turn.inputTokens) ? turn.inputTokens : observed.inputTokens, outputTokens: Number(turn.outputTokens) ? turn.outputTokens : observed.outputTokens, cachedTokens: Number(turn.cachedTokens) ? turn.cachedTokens : observed.cachedTokens, totalTokens: Number(turn.totalTokens) ? turn.totalTokens : observed.totalTokens, cost: turn.cost ?? observed.cost, costSource: turn.costSource || observed.costSource, firstByteMs: turn.firstByteMs ?? observed.firstByteMs, totalMs: turn.totalMs ?? observed.totalMs, groupId: turn.groupId ?? observed.groupId, groupName: turn.groupName ?? observed.groupName, multiplier: turn.multiplier ?? observed.multiplier };
    }
    return turn;
  }
  return requests.find((item) => item.sessionId === convId) || null;
}

function activeProvider(state) {
  return (state?.providers || []).find((provider) => String(provider.id) === String(state.currentGroupId)) || null;
}

function lineFor(read, state) {
  const convId = read?.convId || null;
  const record = recordFor(state, convId);
  const relayName = state?.config?.relayName || "AIHub";
  if (!state) return { text: "中转监控 · 服务离线", convId, offline: true, record: null };
  if (!convId) return { text: `${relayName} · 未识别当前会话 · 展开查看监控`, convId, offline: true, record: null };
  if (!record) return { text: `${relayName} · 当前会话等待首个 Codex 请求… · 展开查看监控`, convId, offline: true, record: null };
  const context = read.context || (record.contextWindow ? { usedTokens: record.contextTokens, contextWindow: record.contextWindow } : null);
  const used = context?.usedTokens ?? record.contextTokens;
  const win = context?.contextWindow ?? record.contextWindow;
  const contextText = win && used !== null && used !== undefined
    ? `上下文 ${compact(used)}/${compact(win)} ${Math.round((Number(used) / Number(win)) * 100)}%`
    : `上下文 ${compact(used)}/${compact(win)}`;
  const provider = activeProvider(state);
  const group = record.groupName || provider?.name;
  const multiplier = record.multiplier ?? provider?.multiplier;
  const groupText = group ? `${group}${Number.isFinite(Number(multiplier)) ? ` ${Number(multiplier).toFixed(2)}x` : ""}` : relayName;
  const running = record.state === "running" ? " · 进行中" : "";
  const balance = state.balance ? ` · 余额 ${state.balance.currency === "USD" ? "$" : `${state.balance.currency} `}${Number(state.balance.amount).toFixed(4)}` : "";
  const text = [
    record.model || "Codex",
    record.reasoningEffort && record.reasoningEffort !== "default" ? record.reasoningEffort : null,
    contextText,
    `${compact(uncachedInput(record))}→${compact(record.outputTokens)}`,
    `缓存 ${compact(record.cachedTokens)}`,
    record.cost == null ? "费用未返回" : `费用 ${money(record.cost)}`,
    `首字 ${milliseconds(record.firstByteMs)}`,
    `总耗时 ${milliseconds(liveDuration(record))}`,
    groupText,
    state.config?.relayAdapter === "aihub" ? (state.config?.mode === "economy" ? "经济" : state.config?.mode === "speed" ? "速度" : "平衡") : null,
  ].filter(Boolean).join(" · ") + balance + running;
  return { text, convId, offline: false, record };
}

function localProviderMetrics(state, providerId) {
  const requests = (state?.telemetry?.requests || []).filter((request) => String(request.groupId) === String(providerId));
  const latency = requests.map((request) => Number(request.firstByteMs)).filter(Number.isFinite);
  const input = requests.reduce((total, request) => total + (Number(request.inputTokens) || 0), 0);
  const cached = requests.reduce((total, request) => total + Math.min(Number(request.inputTokens) || 0, Math.max(0, Number(request.cachedTokens) || 0)), 0);
  const completed = requests.filter((request) => request.state !== "running");
  const successful = completed.filter((request) => request.outcome !== "error" && (!Number.isFinite(Number(request.status)) || Number(request.status) < 400));
  return {
    samples: requests.length,
    ttftMs: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null,
    cacheHitRate: input > 0 ? cached / input : null,
    successRate: completed.length ? successful.length / completed.length : null,
  };
}

function drawerModel(state, record) {
  const config = state?.config || {};
  const auth = state?.runtime?.auth || {};
  const provider = activeProvider(state);
  const errors = state?.runtime?.lastError;
  const errorSummary = errors?.length ? (() => {
    const sources = [...new Set(errors.map((item) => item.source).filter(Boolean))];
    const messages = [...new Set(errors.map((item) => String(item.message || "").trim()).filter(Boolean))];
    if (messages.length === 1 && messages[0].toLowerCase() === "fetch failed") return `AIHub 部分接口暂时不可达 · ${sources.join("、") || "刷新"}`;
    return messages.slice(0, 2).join(" · ") + (messages.length > 2 ? ` · 另有 ${messages.length - 2} 项` : "");
  })() : "";
  const systemText = !state ? "本地监控服务离线"
    : config.relayAdapter === "generic" ? `${config.relayName || "通用中转站"} · 本地指标与费用估算正常`
    : !config.credentialsConfigured ? `本地采集正常 · ${state.providers?.length || 0} 个公开分组 · 尚未登录 AIHub`
      : !auth.authenticated ? `AIHub 登录未通过 · ${auth.lastError || "请重新运行登录脚本"}`
      : errorSummary ? `${errorSummary}${state.runtime?.providerDataStale ? " · 已保留上次分组数据" : ""}`
        : `监控正常 · ${state.providers?.length || 0} 个分组 · ${state.runtime?.proxyObserved ? "代理已接管" : "Codex 正在绕过代理"}`;
  const request = record || {};
  const keySummary = (state?.keys || []).length
    ? `可用 Key：${state.keys.slice(0, 8).map((key) => `${key.id}${key.name ? ` ${key.name}` : ""}`).join("，")}`
    : "尚未读取到 Key";
  const providers = [...(state?.providers || [])].sort((a, b) => (a.multiplier ?? Infinity) - (b.multiplier ?? Infinity) || String(a.id).localeCompare(String(b.id))).map((item) => {
    const local = localProviderMetrics(state, item.id);
    const speed = item.speedValueMs ?? local.ttftMs ?? item.ttftMs;
    const cache = item.cacheHitRate ?? local.cacheHitRate;
    const availability = item.successRate ?? local.successRate;
    const active = String(item.id) === String(state.currentGroupId);
    const authenticated = Boolean(auth.authenticated && ((config.managedKeyIds || []).length || (state.keys || []).length));
    const modelText = { supported: "当前模型已验证", unsupported: "不支持当前模型", unverified: "未检测", unknown: "接口未提供模型列表", warning: "模型检测警告", available: "已提供模型列表" };
    const sourceText = { aihub: "AIHub 接口", local_requests: "本机请求", local_unavailable: "本机无有效样本", aihub_unavailable: "接口未提供" };
    return {
      id: item.id,
      name: item.name || `Group ${item.id}`,
      code: item.code || `#${item.id}`,
      multiplier: item.multiplier == null ? "--" : `${Number(item.multiplier).toFixed(2)}x`,
      status: item.healthLabel || "未检测",
      healthClass: item.healthState === "available" ? "good" : item.healthState === "error" ? "bad" : item.healthState === "cooldown" ? "warn" : "",
      healthDetail: item.healthDetail || "接口未提供健康状态",
      freshness: item.freshness || "未采样",
      models: item.models?.length ? item.models.slice(0, 3).join(" · ") : (modelText[item.modelSupport] || modelText[item.modelCheck] || "接口未提供模型列表"),
      speed: milliseconds(speed),
      speedSource: item.speedSource === "local_requests" ? `本机 ${item.localSampleCount || local.samples} 样本` : item.speedSource === "aihub_public_ttft" ? "AIHub 公共 TTFT" : "未采样",
      cacheHit: cache == null ? (item.cacheHitRateSource === "aihub_unavailable" ? "接口未提供" : local.samples ? "无有效样本" : "未采样") : percent(cache),
      cacheSource: sourceText[item.cacheHitRateSource] || (local.cacheHitRate == null ? "接口未提供" : "本机请求"),
      availability: availability == null ? (item.successRateSource === "aihub_unavailable" ? "接口未提供" : local.samples ? "无有效样本" : "未采样") : percent(availability),
      availabilitySource: sourceText[item.successRateSource] || (local.successRate == null ? "接口未提供" : "本机请求"),
      modelCheck: modelText[item.modelSupport] || modelText[item.modelCheck] || "未检测",
      modelClass: item.modelSupport === "supported" ? "good" : item.modelSupport === "unsupported" ? "bad" : "warn",
      modelSource: item.modelSupportSource === "aihub" ? "AIHub 模型列表" : item.modelSupportSource === "local_requests" ? "本机请求" : "未观测",
      trend: item.trend || [],
      active,
      switchable: Boolean(!active && authenticated && item.switchEligible !== false),
      switchReason: active ? "当前使用的分组" : !config.credentialsConfigured ? "请先登录 AIHub" : !auth.authenticated ? "AIHub 登录未通过" : !(config.managedKeyIds || []).length && !(state.keys || []).length ? "尚未读取到可管理 Key" : item.switchEligible === false ? `不可切换：${(item.switchExcludedReasons || []).join(", ")}` : item.eligible === false ? `可手动切换；自动路由暂不选用：${(item.excludedReasons || []).join(", ")}` : "切换到此分组",
    };
  });
  const activeName = provider ? `${provider.name}${provider.multiplier == null ? "" : ` · ${Number(provider.multiplier).toFixed(2)}x`}` : "尚未识别当前分组";
  return {
    authenticated: Boolean(auth.authenticated),
    authText: auth.authenticated ? "已认证" : config.credentialsConfigured ? "认证失败" : "未登录",
    credentialNote: config.relayAdapter === "generic" ? "通用适配器不读取账户凭据；高级数据可按适配文档扩展" : auth.authenticated ? `AIHub 登录有效 · 已管理 ${(config.managedKeyIds || []).length} 个 · ${keySummary}` : config.credentialsConfigured ? `登录未通过：${auth.lastError || "请重新运行登录脚本"}` : "运行 scripts/set-credential.ps1 登录；不会在聊天中收集密码",
    balanceText: state?.balance ? `${state.balance.currency === "USD" ? "$" : `${state.balance.currency} `}${Number(state.balance.amount).toFixed(6)}` : "--",
    systemText,
    systemLevel: !state || errors?.length || (config.credentialsConfigured && !auth.authenticated) ? "bad" : auth.authenticated ? "good" : "",
    sourceText: state?.runtime?.proxyObserved ? "ROLLOUT + PROXY" : "ROLLOUT ONLY",
    providerDataStale: Boolean(state?.runtime?.providerDataStale),
    mode: config.mode || "balanced",
    routing: config.relayAdapter === "aihub",
    routeName: state?.routeDecision?.selected?.name || activeName,
    routeReason: state?.routeDecision?.reason || (state?.runtime?.proxyObserved ? "等待下一次路由决策" : "代理未启用，错误切组只影响后续请求"),
    request: {
      modelEffort: request.model ? `${request.model} · ${request.reasoningEffort || "default"}` : "等待当前会话请求",
      tokens: request.model ? `${compact(uncachedInput(request))} / ${compact(request.outputTokens)} · 缓存 ${compact(request.cachedTokens)}` : "--",
      latency: request.model ? `${milliseconds(request.firstByteMs)} / ${milliseconds(liveDuration(request))}` : "--",
      cost: request.cost == null ? "费用未返回" : money(request.cost, config.relayCurrency || "USD"),
      costDetail: costDetail(request),
      detail: request.model ? `${request.model} · 非缓存输入 ${compact(uncachedInput(request))} · 缓存读取 ${compact(request.cachedTokens)} · 输出 ${compact(request.outputTokens)} · 总 Token ${compact(request.totalTokens)} · ${request.state === "running" ? "进行中" : request.outcome === "error" ? `错误 ${request.error || ""}` : "已完成"}` : "等待当前会话的第一个请求",
    },
    providers,
    settings: {
      managedKeyIds: config.managedKeyIds || [],
      maximumMultiplier: config.maximumMultiplier,
      routingEnabled: config.routingEnabled,
      failoverEnabled: config.failoverEnabled,
    },
  };
}

class CdpSession {
  constructor(target) {
    this.target = target;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket error")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
        else pending.resolve(message.result);
      }
    });
    await this.send("Runtime.enable", {});
  }
  send(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP disconnected");
    const id = ++this.id;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 5000).unref?.();
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text;
      throw new Error(detail || "CDP evaluate failed");
    }
    return result?.result?.value;
  }
  close() { try { this.socket?.close(); } catch { /* Already disconnected. */ } }
}

async function listTargets() {
  if (!await cdpProbe(activeCdpPort)) activeCdpPort = await discoverCdpPort();
  const response = await fetch(`http://127.0.0.1:${activeCdpPort}/json`, { signal: AbortSignal.timeout(1500) });
  const targets = await response.json();
  return targets.filter((target) =>
    target.type === "page" &&
    target.webSocketDebuggerUrl &&
    /^app:\/\/-\/index\.html(?:$|\?)/.test(target.url || "") &&
    !/avatar-overlay|initialRoute/.test(target.url || ""),
  );
}

const sessions = new Map();
const pageStatus = new Map();
let lastError = null;
let lastErrorAt = null;
let lastSuccessAt = null;

function noteError(error) {
  lastError = error instanceof Error ? error.message : String(error);
  lastErrorAt = new Date().toISOString();
}

async function syncTargets() {
  const targets = await listTargets();
  const ids = new Set(targets.map((target) => target.id));
  for (const [id, session] of sessions) {
    if (!ids.has(id)) { session.close(); sessions.delete(id); pageStatus.delete(id); }
  }
  for (const target of targets) {
    if (sessions.has(target.id)) continue;
    try {
      const session = new CdpSession(target);
      await session.connect();
      sessions.set(target.id, session);
    } catch (error) {
      noteError(`connect ${target.url || target.id}: ${error.message || error}`);
    }
  }
}

async function actionResult(session, id, ok, message) {
  try {
    await session.evaluate(`window.__aihubStatuslineActionResult && window.__aihubStatuslineActionResult(${JSON.stringify(id)}, ${Boolean(ok)}, ${JSON.stringify(message)});`);
  } catch { /* The page may have closed after the action. */ }
}

async function handleActions(session, actions = []) {
  for (const action of actions.slice(0, 10)) {
    try {
      if (action.type === "refresh") await apiCall("/api/actions/refresh", { method: "POST", body: {} });
      else if (action.type === "mode") await apiCall("/api/actions/route", { method: "POST", body: { mode: action.payload?.mode } });
      else if (action.type === "switch") await apiCall("/api/actions/switch", { method: "POST", body: { groupId: action.payload?.groupId } });
      else if (action.type === "configure") await apiCall("/api/config", { method: "PATCH", body: action.payload || {} });
      else throw new Error(`Unknown action: ${action.type}`);
      apiState = null;
      apiStateAt = 0;
      await actionResult(session, action.id, true, action.type === "switch" ? "分组已切换" : action.type === "mode" ? "路由模式已更新" : action.type === "configure" ? "设置已保存" : "供应商数据已刷新");
    } catch (error) {
      await actionResult(session, action.id, false, error.message || String(error));
    }
  }
}

async function tick() {
  await syncTargets();
  const state = await getApiState();
  let successes = 0;
  for (const [id, session] of sessions) {
    try {
      const read = await session.evaluate(`${INSTALL_SCRIPT}; window.__aihubStatuslineRead ? window.__aihubStatuslineRead() : null;`);
      await handleActions(session, read?.actions);
      const freshState = apiState || state;
      const result = lineFor(read, freshState);
      const model = drawerModel(freshState, result.record);
      await session.evaluate(`window.__aihubStatuslineUpdate(${JSON.stringify(result.text)}, ${JSON.stringify(result.convId)}, ${result.offline}, ${JSON.stringify(model)});`);
      const inspection = await session.evaluate("window.__aihubStatuslineInspect ? window.__aihubStatuslineInspect() : null;");
      if (inspection) pageStatus.set(id, inspection);
      successes += 1;
    } catch (error) {
      noteError(`page ${id}: ${error.message || error}`);
      session.close();
      sessions.delete(id);
      pageStatus.delete(id);
    }
  }
  if (successes > 0) {
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    lastErrorAt = null;
  }
}

const healthServer = createServer((request, response) => {
  if (request.url !== "/healthz") { response.writeHead(404).end(); return; }
  const pages = [...pageStatus.values()];
  const body = JSON.stringify({
    ok: true,
    cdpPort: activeCdpPort,
    monitorPort: MONITOR_PORT,
    connectedPages: sessions.size,
    installedPages: pages.filter((page) => page.installed).length,
    visiblePages: pages.filter((page) => page.visible).length,
    pages: pages.map((page) => ({ visible: page.visible, position: page.position, height: page.height, text: String(page.text || "").slice(0, 500), drawerOpen: page.drawerOpen })),
    lastError,
    lastErrorAt,
    lastSuccessAt,
  });
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
});

try {
  await new Promise((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(STATUSLINE_PORT, "127.0.0.1", resolve);
  });
} catch (error) {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
}

console.log(`[aihub-statusline] monitoring Codex CDP ${activeCdpPort}; monitor API ${MONITOR_PORT}`);
for (;;) {
  try { await tick(); } catch (error) { noteError(error); }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
