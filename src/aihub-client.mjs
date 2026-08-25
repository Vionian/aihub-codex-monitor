function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

import { VERSION } from "./version.mjs";

const TOKEN_COOKIE_NAMES = new Set(["auth_token", "access_token", "token"]);

export class AIHubApiError extends Error {
  constructor(message, { status = null, code = null, authenticationFailure = false, cloudflare = false } = {}) {
    super(message);
    this.name = "AIHubApiError";
    this.status = status;
    this.code = code;
    this.authenticationFailure = authenticationFailure;
    this.cloudflare = cloudflare;
  }
}

function sanitizeError(value) {
  return String(value || "AIHub request failed")
    .replace(/(bearer|token|cookie|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function singleLine(value) {
  const result = stringOrEmpty(value).trim();
  if (/[\r\n]/.test(result)) throw new Error("AIHub authentication headers must be a single line");
  return result;
}

function tokenFromCookie(cookie) {
  for (const segment of singleLine(cookie).split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim().toLowerCase();
    if (!TOKEN_COOKIE_NAMES.has(name)) continue;
    try { return decodeURIComponent(segment.slice(separator + 1).trim()); }
    catch { return segment.slice(separator + 1).trim(); }
  }
  return "";
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.code === undefined) return null;
  return String(payload.code);
}

function sessionFrom(value, fallbackRefreshToken = "") {
  const data = unwrap(value);
  if (data?.requires_2fa === true) {
    throw new AIHubApiError("AIHub requires two-factor authentication; this login flow cannot complete it yet", {
      authenticationFailure: true,
    });
  }
  const accessToken = stringOrEmpty(data?.access_token || data?.accessToken).trim();
  if (!accessToken) throw new AIHubApiError("AIHub login response did not include an access token", { authenticationFailure: true });
  const expiresIn = Math.max(0, Number(data?.expires_in ?? data?.expiresIn) || 0);
  return {
    accessToken,
    refreshToken: stringOrEmpty(data?.refresh_token || data?.refreshToken || fallbackRefreshToken).trim(),
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

function unwrap(value) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (current.data !== undefined) current = current.data;
    else if (current.result !== undefined) current = current.result;
    else break;
  }
  return current;
}

function asList(value) {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  for (const key of ["items", "list", "results", "groups", "keys"]) {
    if (Array.isArray(unwrapped?.[key])) return unwrapped[key];
  }
  return [];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratioOrNull(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function stringOrEmpty(value) {
  return value === null || value === undefined ? "" : String(value);
}

function firstValue(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function findBalance(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const keys = ["remaining_balance", "balance", "wallet_balance", "credit_balance", "quota_remaining", "remainingBalance"];
  for (const key of keys) {
    const amount = numberOrNull(value[key]);
    if (amount !== null) {
      return {
        amount,
        currency: stringOrEmpty(value.currency || value.currency_code || "USD").toUpperCase(),
        source: key,
      };
    }
  }
  for (const nested of Object.values(value)) {
    const found = findBalance(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeRateMap(value) {
  const unwrapped = unwrap(value);
  const result = new Map();
  if (Array.isArray(unwrapped)) {
    for (const entry of unwrapped) {
      const id = firstValue(entry, ["group_id", "groupId", "id"]);
      const rate = numberOrNull(firstValue(entry, ["rate_multiplier", "multiplier", "rate", "priceMultiplier"]));
      if (id !== undefined && rate !== null) result.set(String(id), rate);
    }
  } else if (unwrapped && typeof unwrapped === "object") {
    for (const [id, raw] of Object.entries(unwrapped.rates || unwrapped)) {
      const rate = numberOrNull(raw?.rate ?? raw?.multiplier ?? raw);
      if (rate !== null) result.set(String(id), rate);
    }
  }
  return result;
}

function normalizeModels(raw) {
  const value = firstValue(raw, [
    "models", "model_names", "modelNames", "supported_models", "supportedModels",
    "available_models", "availableModels", "model_list", "modelList", "model_support", "modelSupport",
  ]);
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  if (value && typeof value === "object") {
    return Object.entries(value).filter(([, enabled]) => enabled !== false && enabled !== null).map(([name]) => name);
  }
  return [];
}

function normalizeKeys(value) {
  return asList(value).map((key) => {
    const status = stringOrEmpty(firstValue(key, ["status", "state"])).toLowerCase();
    const enabledValue = firstValue(key, ["enabled", "is_enabled", "active"]);
    return {
      id: Number(firstValue(key, ["id", "key_id", "keyId"])),
      name: stringOrEmpty(firstValue(key, ["name", "key_name", "label"])),
      groupId: Number(firstValue(key, ["group_id", "groupId"]) ?? key.group?.id),
      enabled: enabledValue !== false && !["disabled", "inactive", "revoked"].includes(status),
      status: status || null,
      raw: key,
    };
  }).filter((key) => Number.isSafeInteger(key.id) && key.id > 0);
}

function timestampOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (Math.abs(numeric) >= 100_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function usageEstimate(stat, maximumAgeSeconds = 900, now = Date.now()) {
  const rawSamples = Array.isArray(stat?.samples) ? stat.samples : [];
  const samples = rawSamples.map((sample) => {
    const timestamp = timestampOrNull(firstValue(sample, ["timestamp", "sample_at", "created_at", "called_at", "time"]));
    const latency = numberOrNull(firstValue(sample, ["ttft_ms", "first_token_latency_ms", "firstTokenLatencyMs", "latency_ms"]));
    if (timestamp === null || latency === null || latency <= 0) return null;
    const age = now - timestamp;
    if (age < -60_000 || age > maximumAgeSeconds * 1000) return null;
    const halfLife = Math.max(1, maximumAgeSeconds * 500);
    return { timestamp, latency, weight: Math.exp((-Math.log(2) * Math.max(age, 0)) / halfLife) };
  }).filter(Boolean);
  if (samples.length) {
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    return {
      ttftMs: samples.reduce((sum, sample) => sum + sample.latency * sample.weight, 0) / weight,
      sampleCount: samples.length,
      lastSampleAt: new Date(Math.max(...samples.map((sample) => sample.timestamp))).toISOString(),
    };
  }
  return {
    ttftMs: numberOrNull(firstValue(stat, ["avg_ttft_ms", "first_token_latency_ms", "firstTokenLatencyMs"])),
    sampleCount: numberOrNull(firstValue(stat, ["sample_count", "count", "samples_count"])) || 0,
    lastSampleAt: firstValue(stat, ["last_sample_at", "lastSampleAt", "checked_at", "checkedAt"]) || null,
  };
}

function mergeProviders(statsValue, groupsValue, ratesValue, config = {}) {
  const stats = asList(statsValue);
  const groups = asList(groupsValue);
  const rates = normalizeRateMap(ratesValue);
  const byId = new Map();

  for (const group of groups) {
    const id = firstValue(group, ["id", "group_id", "groupId"]);
    if (id === undefined) continue;
    byId.set(String(id), { group, stat: null });
  }
  for (const stat of stats) {
    const id = firstValue(stat, ["group_id", "groupId", "id"]);
    if (id === undefined) continue;
    const entry = byId.get(String(id)) || { group: {}, stat: null };
    entry.stat = stat;
    byId.set(String(id), entry);
  }

  return [...byId.entries()].map(([id, { group, stat }]) => {
    const usage = usageEstimate(stat, config.maximumStatusAgeSeconds);
    const multiplier = rates.get(id) ?? numberOrNull(firstValue(stat, ["rate_multiplier", "multiplier", "rate"])) ??
      numberOrNull(firstValue(group, ["rate_multiplier", "multiplier", "rate", "priceMultiplier"]));
    const status = stringOrEmpty(firstValue(group, ["status", "state", "model_status"]));
    // `enabled` only means the group is configured. It is not a health signal.
    // Treating it as availability made every unprobed group look healthy.
    const availableValue = firstValue(group, ["available", "is_available", "health_available"]);
    const statusAvailable = status
      ? !["unavailable", "disabled", "offline", "error"].includes(status.toLowerCase())
      : null;
    const successRates = asObject(firstValue(stat, ["success_rates", "successRates"]));
    const successRate = ratioOrNull(firstValue(stat, ["success_rate_6h", "availability", "success_rate"]) ?? successRates["6h"]);
    const warnings = firstValue(group, ["warning_reasons", "warningReasons", "warnings"]);
    const models = [...new Set([...normalizeModels(group), ...normalizeModels(stat)])];
    return {
      id: Number.isFinite(Number(id)) ? Number(id) : id,
      code: stringOrEmpty(firstValue(stat, ["code", "group_code"]) || firstValue(group, ["code", "name"])),
      name: stringOrEmpty(firstValue(group, ["name", "display_name", "code"]) || firstValue(stat, ["code"]) || `Group ${id}`),
      multiplier,
      status: status || (availableValue === false ? "unavailable" : availableValue === true ? "available" : "observed"),
      available: availableValue === undefined ? statusAvailable : availableValue !== false,
      enabled: firstValue(group, ["enabled", "is_enabled"]) !== false,
      platform: stringOrEmpty(firstValue(stat, ["platform"]) || firstValue(group, ["platform"])),
      ttftMs: usage.ttftMs,
      outputTokensPerSecond: numberOrNull(firstValue(stat, ["output_tokens_per_second", "outputTokensPerSecond", "tokens_per_second"])),
      sampleCount: usage.sampleCount,
      lastSampleAt: usage.lastSampleAt,
      cacheHitRate: ratioOrNull(firstValue(stat, ["cache_hit_rate", "cacheHitRate", "cached_ratio"])),
      successRate,
      models,
      modelCheck: warnings?.length ? "warning" : models.length ? "available" : "unknown",
      warnings: Array.isArray(warnings) ? warnings : [],
    };
  });
}

export class AIHubClient {
  constructor({ baseUrl, accessToken, cookie = "", userAgent = "", fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookie = singleLine(cookie);
    this.accessToken = singleLine(accessToken) || tokenFromCookie(this.cookie);
    this.userAgent = singleLine(userAgent) || `aihub-codex-monitor/${VERSION}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body, auth = true } = {}) {
    const authenticationEndpoint = path.startsWith("/api/v1/auth/");
    if (auth && !this.accessToken && !this.cookie) throw new AIHubApiError("AIHub login is not configured", { authenticationFailure: true });
    const origin = new URL(this.baseUrl).origin;
    const headers = {
      accept: "application/json",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
      "user-agent": this.userAgent,
      origin,
      referer: `${origin}/`,
    };
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AIHubApiError(`AIHub rejected redirect (${response.status})`, { status: response.status });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 500) }; }
    }
    const cloudflare = /just a moment|cf-chl-|challenge-platform|verify you are human|确认您是真人/i.test(text) ||
      response.headers.get("server")?.toLowerCase().includes("cloudflare") && response.status === 403;
    if (cloudflare) {
      throw new AIHubApiError("AIHub Cloudflare verification is required; configure a cf_clearance Cookie and matching browser User-Agent", {
        status: response.status,
        cloudflare: true,
      });
    }
    const code = responseCode(payload);
    if (!response.ok) {
      const message = payload?.message || payload?.error?.message || `AIHub API returned ${response.status}`;
      throw new AIHubApiError(sanitizeError(message), {
        status: response.status,
        code,
        authenticationFailure: response.status === 401 || authenticationEndpoint || (auth && /invalid token|unauth|认证|登录/i.test(String(message))),
      });
    }
    if (code !== null && code !== "0") {
      const message = payload?.message || payload?.error?.message || `AIHub API returned code ${code}`;
      throw new AIHubApiError(sanitizeError(message), {
        status: response.status,
        code,
        authenticationFailure: authenticationEndpoint || (auth && /invalid token|unauth|认证|登录/i.test(String(message))),
      });
    }
    return payload;
  }

  async login(email, password) {
    if (!String(email || "").trim() || !String(password || "")) {
      throw new AIHubApiError("AIHub login email and password are required", { authenticationFailure: true });
    }
    const payload = await this.request("/api/v1/auth/login", {
      method: "POST",
      body: { email: String(email).trim(), password: String(password) },
      auth: false,
    });
    return sessionFrom(payload);
  }

  async refreshSession(refreshToken) {
    if (!String(refreshToken || "").trim()) throw new AIHubApiError("AIHub refresh token is missing", { authenticationFailure: true });
    const payload = await this.request("/api/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: String(refreshToken).trim() },
      auth: false,
    });
    return sessionFrom(payload, refreshToken);
  }

  async validateLogin() {
    return this.request("/api/v1/auth/me");
  }

  async getUsageStats(config) {
    const query = new URLSearchParams({ samples: String(config.samples), platform: config.platform });
    if (Number.isFinite(config.maximumMultiplier)) query.set("max_rate", String(config.maximumMultiplier));
    return this.request(`/api/v1/public/groups/usage-stats?${query}`, { auth: false });
  }

  async getAvailableGroups() {
    return this.request("/api/v1/groups/available");
  }

  async getUserRates() {
    return this.request("/api/v1/groups/rates");
  }

  async getAllKeys() {
    const keys = [];
    for (let page = 1; page <= 20; page += 1) {
      const payload = await this.request(`/api/v1/keys?page=${page}&page_size=100&sort_by=created_at&sort_order=desc`);
      const items = asList(payload);
      keys.push(...items);
      const root = asObject(unwrap(payload));
      const total = numberOrNull(root.total ?? payload?.total);
      if (!items.length || items.length < 100 || (total !== null && keys.length >= total)) break;
    }
    return keys;
  }

  async getAccount() {
    return this.request("/api/v1/auth/me");
  }

  async updateKeyGroup(keyId, groupId) {
    return this.request(`/api/v1/keys/${encodeURIComponent(keyId)}`, { method: "PUT", body: { group_id: groupId } });
  }

  async switchManagedKeys(keyIds, groupId) {
    const results = await Promise.allSettled(keyIds.map((keyId) => this.updateKeyGroup(keyId, groupId)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new Error(`AIHub updated ${results.length - failures.length}/${results.length} managed Keys`);
    return results.map((result) => result.value);
  }

  async refresh(config, { includePrivate = true } = {}) {
    const tasks = {
      stats: this.getUsageStats(config),
      groups: includePrivate ? this.getAvailableGroups() : Promise.resolve([]),
      rates: includePrivate ? this.getUserRates() : Promise.resolve({}),
      keys: includePrivate ? this.getAllKeys() : Promise.resolve([]),
      account: includePrivate ? this.getAccount() : Promise.resolve(null),
    };
    const names = Object.keys(tasks);
    const settled = await Promise.allSettled(Object.values(tasks));
    const values = {};
    const errors = [];
    settled.forEach((result, index) => {
      const name = names[index];
      if (result.status === "fulfilled") values[name] = result.value;
      else {
        values[name] = name === "rates" ? {} : [];
        errors.push({
          source: name,
          message: result.reason?.message || String(result.reason),
          status: result.reason?.status || null,
          authenticationFailure: result.reason?.authenticationFailure === true,
          cloudflare: result.reason?.cloudflare === true,
        });
      }
    });
    const keys = normalizeKeys(values.keys);
    const managedSet = new Set(config.managedKeyIds.map(Number));
    const activeKey = keys.find((key) => managedSet.has(key.id)) || (config.managedKeyIds.length ? null : keys[0]);
    return {
      providers: mergeProviders(values.stats, values.groups, values.rates, config),
      keys: keys.map(({ raw, ...key }) => key),
      currentGroupId: Number.isFinite(activeKey?.groupId) ? activeKey.groupId : null,
      balance: findBalance(values.account),
      errors,
    };
  }
}
