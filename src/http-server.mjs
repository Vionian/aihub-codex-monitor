import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createResponseInspector } from "./telemetry.mjs";
import { VERSION } from "./version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function trustedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function writeJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

async function readBody(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 256 * 1024) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const body = await readBody(request, limit);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

function upstreamHeaders(requestHeaders) {
  const headers = new Headers();
  const blocked = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]);
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  headers.set("accept-encoding", "identity");
  headers.set("x-relay-codex-monitor", VERSION);
  return headers;
}

function copyResponseHeaders(source, target) {
  const blocked = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "set-cookie"]);
  for (const [name, value] of source.entries()) {
    if (!blocked.has(name.toLowerCase())) target.setHeader(name, value);
  }
  target.setHeader("cache-control", "no-store");
  target.setHeader("x-relay-codex-monitor", VERSION);
}

function parseRequestMetadata(buffer, request) {
  let payload = {};
  if (buffer.length && String(request.headers["content-type"] || "").includes("json")) {
    try { payload = JSON.parse(buffer.toString("utf8")); } catch { /* Upstream will report malformed JSON. */ }
  }
  return {
    model: String(payload.model || "unknown"),
    reasoningEffort: String(payload.reasoning?.effort || payload.reasoning_effort || "default"),
    stream: payload.stream === true,
  };
}

function groupSnapshot(service) {
  return service.providers.find((provider) => String(provider.id) === String(service.currentGroupId)) || null;
}

async function proxyModelRequest(request, response, service, fetchImpl) {
  const requestId = randomUUID();
  const body = await readBody(request);
  const metadata = parseRequestMetadata(body, request);
  const startClock = performance.now();
  const startedAt = new Date().toISOString();
  const failovers = [];
  let firstByteMs = null;
  let finalStatus = 502;
  let finalError = null;
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cost: null, costSource: "unavailable" };
  const requestGroup = groupSnapshot(service);
  let finalGroup = requestGroup;
  let recorded = false;

  const record = () => {
    if (recorded) return;
    recorded = true;
    service.recordRequest({
      id: requestId,
      startedAt,
      finishedAt: new Date().toISOString(),
      endpoint: request.url,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
      groupId: finalGroup?.id ?? service.currentGroupId,
      groupName: finalGroup?.name || service.config.relayName || null,
      multiplier: finalGroup?.multiplier ?? service.config.relayMultiplier ?? 1,
      status: finalStatus,
      firstByteMs,
      totalMs: Math.round((performance.now() - startClock) * 100) / 100,
      failovers,
      error: finalError,
      source: "proxy",
      sources: {
        identity: "proxy",
        usage: finalUsage.totalTokens > 0 ? "proxy" : null,
        latency: "proxy",
        cost: finalUsage.costSource === "unavailable" ? null : finalUsage.costSource,
        group: finalGroup ? "proxy" : null,
      },
      ...finalUsage,
    });
  };

  const controller = new AbortController();
  request.once("aborted", () => controller.abort(new Error("Codex disconnected")));

  const switchForNextRetry = async ({ statusCode = null, error = null, cause }) => {
    if (service.config.failoverEnabled === false || controller.signal.aborted) return;
    try {
      const result = await service.failover({ attemptedGroupIds: requestGroup ? [requestGroup.id] : [], statusCode, error });
      failovers.push({
        at: new Date().toISOString(),
        cause,
        scope: "next_codex_retry",
        fromGroupId: requestGroup?.id ?? null,
        toGroupId: result.group?.id ?? null,
        switched: result.switched,
      });
    } catch (switchError) {
      finalError = `${finalError || error || `Upstream ${statusCode}`}; failover: ${switchError.message}`;
    }
  };

  let upstream;
  try {
    const target = new URL(request.url, `${service.config.relayBaseUrl || service.config.aihubBaseUrl}/`);
    if ((target.hostname === service.config.host || target.hostname === "localhost") && Number(target.port || 80) === service.config.port) {
      throw new Error("Relay upstream URL points back to the monitor");
    }
    upstream = await fetchImpl(target, {
      method: request.method,
      headers: upstreamHeaders(request.headers),
      body: body.length ? body : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    finalStatus = 502;
    finalError = error.message;
    await switchForNextRetry({ error: error.message, cause: "network" });
    if (!response.headersSent) writeJson(response, 502, { error: { message: `${service.config.relayName || "Relay"} upstream connection failed`, type: "upstream_error" } });
    record();
    return;
  }

  finalStatus = upstream.status;
  if (service.config.retryStatusCodes.includes(upstream.status)) {
    finalError = `Upstream returned ${upstream.status}`;
    await switchForNextRetry({ statusCode: upstream.status, cause: upstream.status });
  }

  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  copyResponseHeaders(upstream.headers, response);
  const billingGroup = requestGroup || groupSnapshot(service);
  if (!finalGroup && billingGroup) finalGroup = billingGroup;
  const inspector = createResponseInspector({
    model: service.config.modelAliases?.[metadata.model] || metadata.model,
    pricingTable: service.config.modelPricing,
    headers: upstream.headers,
    multiplier: billingGroup?.multiplier ?? service.config.relayMultiplier ?? 1,
  });

  try {
    if (!upstream.body) {
      response.end();
    } else {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = Math.round((performance.now() - startClock) * 100) / 100;
        inspector.consume(value);
        if (!response.write(Buffer.from(value))) await new Promise((resolve) => response.once("drain", resolve));
      }
      response.end();
    }
    finalUsage = inspector.finish();
    if (!upstream.ok && !finalError) finalError = `Upstream returned ${upstream.status}`;
  } catch (error) {
    finalError = `Upstream stream failed: ${error.message}`;
    await switchForNextRetry({ error: `stream:${error.message}`, cause: "stream" });
    if (!response.headersSent) writeJson(response, 502, { error: { message: `${service.config.relayName || "Relay"} upstream stream failed`, type: "upstream_error" } });
    else response.destroy(error);
  }
  record();
}

export function createMonitorHttpServer(service, { fetchImpl = globalThis.fetch } = {}) {
  const eventClients = new Set();
  const broadcast = (state) => {
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of eventClients) client.write(payload);
  };
  service.on("state", broadcast);

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) return writeJson(response, 403, { error: "Loopback access only" });
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

      if (url.pathname.startsWith("/v1/")) {
        return await proxyModelRequest(request, response, service, fetchImpl);
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return writeJson(response, 200, { ok: true, version: VERSION });
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return writeJson(response, 200, service.status());
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(`event: state\ndata: ${JSON.stringify(service.status())}\n\n`);
        eventClients.add(response);
        request.on("close", () => eventClients.delete(response));
        return;
      }

      if (["PATCH", "POST"].includes(request.method) && !trustedOrigin(request.headers.origin)) {
        return writeJson(response, 403, { error: "Untrusted browser origin" });
      }
      if (request.method === "PATCH" && url.pathname === "/api/config") {
        const result = await service.configure(await readJson(request));
        return writeJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/actions/refresh") {
        await readJson(request);
        return writeJson(response, 200, await service.refresh());
      }
      if (request.method === "POST" && url.pathname === "/api/actions/reload-credentials") {
        await readJson(request);
        return writeJson(response, 200, await service.reloadCredentials());
      }
      if (request.method === "POST" && url.pathname === "/api/actions/route") {
        const body = await readJson(request);
        if (body.mode) await service.configure({ mode: body.mode });
        return writeJson(response, 200, await service.refresh());
      }
      if (request.method === "POST" && url.pathname === "/api/actions/switch") {
        const body = await readJson(request);
        const result = await service.switchGroup(body.groupId, "manual:dashboard");
        return writeJson(response, 200, { result, state: service.status() });
      }

      const asset = ASSETS[url.pathname];
      if (request.method === "GET" && asset) {
        const body = await readFile(path.join(ROOT, "assets", asset.file));
        response.writeHead(200, {
          "content-type": asset.type,
          "content-length": body.length,
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self' codex:; base-uri 'none'; form-action 'self'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return;
      }
      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent) writeJson(response, 400, { error: error.message });
      else response.destroy(error);
    }
  });

  server.on("close", () => {
    service.off("state", broadcast);
    for (const client of eventClients) client.end();
    eventClients.clear();
  });
  return server;
}

export function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
