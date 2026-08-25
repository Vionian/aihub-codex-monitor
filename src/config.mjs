import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MODEL_PRICING = Object.freeze({
  "gpt-5.6-sol": Object.freeze({ inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 }),
});

export const DEFAULT_CONFIG = Object.freeze({
  host: "127.0.0.1",
  port: 48160,
  relayAdapter: "aihub",
  relayName: "AIHub",
  relayBaseUrl: "https://aihub.top",
  relayMultiplier: 1,
  relayCurrency: "USD",
  modelAliases: {},
  aihubBaseUrl: "https://aihub.top",
  platform: "openai",
  mode: "balanced",
  managedKeyIds: [],
  blacklistedGroupIds: [],
  routingEnabled: true,
  failoverEnabled: true,
  rolloutEnabled: true,
  rolloutPollIntervalMs: 1000,
  rolloutHistoryFiles: 24,
  pollIntervalSeconds: 60,
  samples: 100,
  minimumMultiplier: 0,
  maximumMultiplier: 0.15,
  minimumConfidence: 0.9,
  confidenceImpact: 1,
  groupStickiness: 0.1,
  maximumStatusAgeSeconds: 900,
  groupCooldownSeconds: 60,
  switchPropagationDelayMs: 400,
  retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
  modelPricing: DEFAULT_MODEL_PRICING,
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const MODES = new Set(["economy", "balanced", "speed"]);

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function numberInRange(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function integerInRange(value, fallback, min, max) {
  return Math.trunc(numberInRange(value, fallback, min, max));
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_CONFIG.aihubBaseUrl));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      return DEFAULT_CONFIG.aihubBaseUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_CONFIG.aihubBaseUrl;
  }
}

function normalizeAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([from, to]) => [String(from).trim(), String(to || "").trim()])
    .filter(([from, to]) => from && to)
    .slice(0, 200));
}

function normalizePricing(value) {
  const source = { ...DEFAULT_MODEL_PRICING, ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
  const result = {};
  for (const [model, pricing] of Object.entries(source)) {
    if (!pricing || typeof pricing !== "object" || !model.trim()) continue;
    result[model.trim()] = {
      inputPerMillion: numberInRange(pricing.inputPerMillion, 0, 0, 1_000_000),
      cachedInputPerMillion: numberInRange(pricing.cachedInputPerMillion, 0, 0, 1_000_000),
      outputPerMillion: numberInRange(pricing.outputPerMillion, 0, 0, 1_000_000),
    };
  }
  return result;
}

export function normalizeConfig(input = {}) {
  const source = { ...DEFAULT_CONFIG, ...input };
  const relayAdapter = String(source.relayAdapter || DEFAULT_CONFIG.relayAdapter).trim().toLowerCase() === "generic" ? "generic" : "aihub";
  const configuredRelayBaseUrl = Object.prototype.hasOwnProperty.call(input, "relayBaseUrl")
    ? input.relayBaseUrl
    : Object.prototype.hasOwnProperty.call(input, "aihubBaseUrl") ? input.aihubBaseUrl : source.relayBaseUrl;
  const relayBaseUrl = normalizeBaseUrl(configuredRelayBaseUrl);
  const minimumMultiplier = numberInRange(source.minimumMultiplier, DEFAULT_CONFIG.minimumMultiplier, 0, 1000);
  const maximumMultiplier = numberInRange(source.maximumMultiplier, Math.max(DEFAULT_CONFIG.maximumMultiplier, minimumMultiplier), minimumMultiplier, 1000);
  const retryStatusCodes = Array.isArray(source.retryStatusCodes)
    ? [...new Set(source.retryStatusCodes.map(Number).filter((code) => Number.isInteger(code) && code >= 400 && code <= 599))]
    : [...DEFAULT_CONFIG.retryStatusCodes];

  return {
    host: "127.0.0.1",
    port: integerInRange(source.port, DEFAULT_CONFIG.port, 1024, 65535),
    relayAdapter,
    relayName: String(source.relayName || (relayAdapter === "aihub" ? "AIHub" : "中转站")).trim().slice(0, 80) || "中转站",
    relayBaseUrl,
    relayMultiplier: numberInRange(source.relayMultiplier, DEFAULT_CONFIG.relayMultiplier, 0, 1000),
    relayCurrency: String(source.relayCurrency || DEFAULT_CONFIG.relayCurrency).trim().toUpperCase().slice(0, 8) || "USD",
    modelAliases: normalizeAliases(source.modelAliases),
    aihubBaseUrl: relayAdapter === "aihub" ? relayBaseUrl : normalizeBaseUrl(source.aihubBaseUrl),
    platform: String(source.platform || DEFAULT_CONFIG.platform).trim().slice(0, 64) || DEFAULT_CONFIG.platform,
    mode: MODES.has(source.mode) ? source.mode : DEFAULT_CONFIG.mode,
    managedKeyIds: Array.isArray(source.managedKeyIds)
      ? [...new Set(source.managedKeyIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
      : [],
    blacklistedGroupIds: Array.isArray(source.blacklistedGroupIds)
      ? [...new Set(source.blacklistedGroupIds.map(String).map((id) => id.trim()).filter(Boolean))]
      : [],
    routingEnabled: source.routingEnabled !== false,
    failoverEnabled: source.failoverEnabled !== false,
    rolloutEnabled: source.rolloutEnabled !== false,
    rolloutPollIntervalMs: integerInRange(source.rolloutPollIntervalMs, DEFAULT_CONFIG.rolloutPollIntervalMs, 250, 10000),
    rolloutHistoryFiles: integerInRange(source.rolloutHistoryFiles, DEFAULT_CONFIG.rolloutHistoryFiles, 1, 200),
    pollIntervalSeconds: integerInRange(source.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds, 15, 3600),
    samples: integerInRange(source.samples, DEFAULT_CONFIG.samples, 1, 500),
    minimumMultiplier,
    maximumMultiplier,
    minimumConfidence: numberInRange(source.minimumConfidence, DEFAULT_CONFIG.minimumConfidence, 0, 1),
    confidenceImpact: numberInRange(source.confidenceImpact, DEFAULT_CONFIG.confidenceImpact, 0, 10),
    groupStickiness: numberInRange(source.groupStickiness, DEFAULT_CONFIG.groupStickiness, 0, 10),
    maximumStatusAgeSeconds: integerInRange(source.maximumStatusAgeSeconds, DEFAULT_CONFIG.maximumStatusAgeSeconds, 60, 86400),
    groupCooldownSeconds: integerInRange(source.groupCooldownSeconds, DEFAULT_CONFIG.groupCooldownSeconds, 5, 3600),
    switchPropagationDelayMs: integerInRange(source.switchPropagationDelayMs, DEFAULT_CONFIG.switchPropagationDelayMs, 0, 10000),
    retryStatusCodes: retryStatusCodes.length ? retryStatusCodes : [...DEFAULT_CONFIG.retryStatusCodes],
    modelPricing: normalizePricing(source.modelPricing),
  };
}

export function patchConfig(current, patch) {
  const allowed = {};
  if (patch && typeof patch === "object") {
    for (const [key, value] of Object.entries(patch)) {
      if (CONFIG_KEYS.has(key) && key !== "host" && key !== "port") allowed[key] = value;
    }
  }
  return normalizeConfig({ ...current, ...allowed });
}

export function resolveDataDir(env = process.env) {
  if (env.AIHUB_MONITOR_DATA_DIR) return path.resolve(env.AIHUB_MONITOR_DATA_DIR);
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "AIHubCodexMonitor");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AIHubCodexMonitor");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aihub-codex-monitor");
}

export async function loadConfig({ env = process.env, dataDir = resolveDataDir(env) } = {}) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`[aihub-monitor] Ignoring invalid config: ${error.message}\n`);
  }
  const overrides = {};
  if (env.AIHUB_BASE_URL) overrides.aihubBaseUrl = env.AIHUB_BASE_URL;
  if (env.RELAY_ADAPTER) overrides.relayAdapter = env.RELAY_ADAPTER;
  if (env.RELAY_NAME) overrides.relayName = env.RELAY_NAME;
  if (env.RELAY_BASE_URL) overrides.relayBaseUrl = env.RELAY_BASE_URL;
  if (env.AIHUB_MONITOR_PORT) overrides.port = env.AIHUB_MONITOR_PORT;
  return { config: normalizeConfig({ ...stored, ...overrides }), dataDir };
}

export async function saveConfig(dataDir, config) {
  await mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, "config.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export function publicConfig(config, env = process.env) {
  const configured = Boolean(
    env.AIHUB_ACCESS_TOKEN?.trim() ||
    env.AIHUB_COOKIE?.trim() ||
    (env.AIHUB_EMAIL?.trim() && env.AIHUB_PASSWORD),
  );
  return {
    ...config,
    credentialsConfigured: configured,
    credentialsValid: false,
    credentialSource: env.AIHUB_CREDENTIAL_SOURCE || (configured ? "environment" : null),
  };
}
