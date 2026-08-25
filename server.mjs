#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.mjs";
import { loadCredentials } from "./src/credentials.mjs";
import { createMonitorHttpServer, listen } from "./src/http-server.mjs";
import { MonitorService } from "./src/service.mjs";
import { VERSION } from "./src/version.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

async function probe(url, timeout = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function discoverCdpPort() {
  const requested = Number(process.env.AIHUB_STATUSLINE_CDP_PORT || 0);
  const ports = [];
  if (requested > 0) ports.push(requested);
  if (requested <= 0 && process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\").CommandLine",
      ], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true });
      for (const match of String(stdout).matchAll(/--remote-debugging-port=(\d+)/gi)) ports.push(Number(match[1]));
    } catch {}
  }
  ports.push(9347, 9224, 9222);
  for (const port of [...new Set(ports.filter((value) => Number.isInteger(value) && value > 0))]) {
    if (await probe(`http://127.0.0.1:${port}/json`, 800)) return port;
  }
  return requested > 0 ? requested : 9224;
}

async function statuslineStatus({ start = true } = {}) {
  const cdpPort = await discoverCdpPort();
  const monitorPort = Number(process.env.AIHUB_MONITOR_PORT || 48160);
  const healthPort = Number(process.env.AIHUB_STATUSLINE_HEALTH_PORT || 48161);
  const cdp = await probe(`http://127.0.0.1:${cdpPort}/json`);
  let injector = await probe(`http://127.0.0.1:${healthPort}/healthz`);
  const launcher = path.join(ROOT, "statusline", "launch-statusline.ps1");
  if (start && cdp && !injector && process.platform === "win32") {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", launcher,
      "-CdpPort", String(cdpPort),
      "-MonitorPort", String(monitorPort),
      "-HealthPort", String(healthPort),
    ], { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
    for (let attempt = 0; attempt < 12 && !injector; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      injector = await probe(`http://127.0.0.1:${healthPort}/healthz`, 500);
    }
  }
  return {
    supported: process.platform === "win32",
    placement: "above-composer",
    live: Boolean(injector),
    cdpReady: Boolean(cdp),
    connectedPages: injector?.connectedPages || 0,
    injectedPages: injector?.installedPages || 0,
    visiblePages: injector?.visiblePages || 0,
    pageStatus: injector?.pages || [],
    refreshMilliseconds: 1500,
    requiresCodexRestart: process.platform === "win32" && !cdp,
    restartCommand: process.platform === "win32" && !cdp
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcher}" -RestartCodex`
      : null,
  };
}

class RemoteRuntime {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async call(path, { method = "GET", body } = {}) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Monitor returned ${response.status}`);
    return payload;
  }

  status() { return this.call("/api/state"); }
  refresh() { return this.call("/api/actions/refresh", { method: "POST", body: {} }); }
  configure(patch) { return this.call("/api/config", { method: "PATCH", body: patch }); }
  async switchGroup(groupId) {
    const payload = await this.call("/api/actions/switch", { method: "POST", body: { groupId } });
    return payload.result;
  }
}

function compactStatus(state, includeRequests = false) {
  const result = structuredClone(state);
  if (!includeRequests && result.telemetry?.requests) result.telemetry.requests = result.telemetry.requests.slice(0, 10);
  if (result.routeDecision?.candidates) result.routeDecision.candidates = result.routeDecision.candidates.slice(0, 30);
  return result;
}

const TOOLS = [
  {
    name: "aihub_monitor_status",
    description: "Read live AIHub provider, balance, routing, and Codex request telemetry.",
    inputSchema: { type: "object", properties: { includeRequests: { type: "boolean", default: false } }, additionalProperties: false },
  },
  {
    name: "aihub_monitor_dashboard",
    description: "Return the loopback dashboard URL and requested Codex panel placement.",
    inputSchema: { type: "object", properties: { placement: { type: "string", enum: ["bottom", "right"], default: "bottom" } }, additionalProperties: false },
  },
  {
    name: "aihub_monitor_statusline",
    description: "Check or start the live AIHub status line above the Codex desktop composer. This never restarts Codex.",
    inputSchema: { type: "object", properties: { start: { type: "boolean", default: true } }, additionalProperties: false },
  },
  {
    name: "aihub_monitor_refresh",
    description: "Refresh AIHub groups, rates, Key state, balance, and the automatic route decision now.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aihub_monitor_set_mode",
    description: "Set economy, balanced, or speed routing and immediately refresh the decision.",
    inputSchema: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["economy", "balanced", "speed"] } }, additionalProperties: false },
  },
  {
    name: "aihub_monitor_switch_group",
    description: "Switch all configured managed AIHub Key IDs to one eligible group.",
    inputSchema: { type: "object", required: ["groupId"], properties: { groupId: { type: "integer", minimum: 1 } }, additionalProperties: false },
  },
  {
    name: "aihub_monitor_configure",
    description: "Update non-secret routing settings. Credentials cannot be passed to this tool.",
    inputSchema: {
      type: "object",
      properties: {
        managedKeyIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
        blacklistedGroupIds: { type: "array", items: { type: ["integer", "string"] }, maxItems: 100 },
        routingEnabled: { type: "boolean" },
        failoverEnabled: { type: "boolean" },
        pollIntervalSeconds: { type: "integer", minimum: 15, maximum: 3600 },
        minimumMultiplier: { type: "number", minimum: 0 },
        maximumMultiplier: { type: "number", minimum: 0 },
        minimumConfidence: { type: "number", minimum: 0, maximum: 1 },
        groupStickiness: { type: "number", minimum: 0, maximum: 10 },
        groupCooldownSeconds: { type: "integer", minimum: 5, maximum: 3600 }
      },
      additionalProperties: false
    },
  },
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function callTool(runtime, name, args = {}) {
  if (name === "aihub_monitor_status") return toolResult(compactStatus(await runtime.status(), args.includeRequests));
  if (name === "aihub_monitor_dashboard") {
    const state = await runtime.status();
    const placement = args.placement || "bottom";
    const layout = placement === "right" ? "vertical" : "horizontal";
    const url = new URL(state.runtime.dashboardUrl);
    url.searchParams.set("layout", layout);
    return toolResult({ url: url.toString(), placement, layout });
  }
  if (name === "aihub_monitor_statusline") return toolResult(await statuslineStatus(args));
  if (name === "aihub_monitor_refresh") return toolResult(compactStatus(await runtime.refresh()));
  if (name === "aihub_monitor_set_mode") {
    await runtime.configure({ mode: args.mode });
    return toolResult(compactStatus(await runtime.refresh()));
  }
  if (name === "aihub_monitor_switch_group") return toolResult(await runtime.switchGroup(args.groupId));
  if (name === "aihub_monitor_configure") return toolResult(compactStatus(await runtime.configure(args)));
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRpc(runtime, request) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aihub-codex-monitor", version: VERSION },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
    return;
  }
  if (request.method === "tools/call") {
    try {
      const result = await callTool(runtime, request.params?.name, request.params?.arguments || {});
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
    }
    return;
  }
  if (request.id !== undefined && !request.method?.startsWith("notifications/")) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
}

function startRpc(runtime) {
  let buffer = Buffer.alloc(0);
  stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const text = buffer.toString("utf8");
      if (/^Content-Length:/i.test(text)) {
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        const match = text.slice(0, end).match(/Content-Length:\s*(\d+)/i);
        const length = Number(match?.[1]);
        const bodyStart = Buffer.byteLength(text.slice(0, end + 4));
        if (!Number.isFinite(length) || buffer.length < bodyStart + length) return;
        const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
        buffer = buffer.subarray(bodyStart + length);
        try { void handleRpc(runtime, JSON.parse(body)); }
        catch (error) { process.stderr.write(`[aihub-monitor] Invalid framed JSON-RPC: ${error.message}\n`); }
      } else {
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8").trim();
        buffer = buffer.subarray(newline + 1);
        if (line) {
          try { void handleRpc(runtime, JSON.parse(line)); }
          catch (error) { process.stderr.write(`[aihub-monitor] Invalid JSON-RPC line: ${error.message}\n`); }
        }
      }
    }
  });
}

async function main() {
  const standalone = process.argv.includes("--standalone");
  const { config, dataDir } = await loadConfig();
  const credential = await loadCredentials({ dataDir });
  const service = new MonitorService({
    config,
    dataDir,
    env: process.env,
    credentials: credential.credentials,
    credentialSource: credential.source,
  });
  if (credential.error) {
    service.credentialError = credential.error;
    service.lastError = [{ source: "credential", message: credential.error }];
  }
  const server = createMonitorHttpServer(service);
  let runtime = service;
  try {
    await listen(server, config.host, config.port);
    service.start();
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    runtime = new RemoteRuntime(`http://${config.host}:${config.port}/`);
    const remoteState = await runtime.status();
    if (remoteState.runtime?.version !== VERSION) {
      const remoteVersion = remoteState.runtime?.version || "legacy/unknown";
      throw new Error(`Port ${config.port} is occupied by AIHub Codex Monitor ${remoteVersion}; stop it before starting ${VERSION}`);
    }
  }

  if (standalone) {
    process.stdout.write(`AIHub Codex Monitor: http://${config.host}:${config.port}/\n`);
  } else {
    startRpc(runtime);
  }

  const shutdown = () => {
    service.stop();
    if (server.listening) server.close(() => process.exit(0));
    else process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`[aihub-monitor] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
