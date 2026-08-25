import { EventEmitter } from "node:events";
import { AIHubClient } from "./aihub-client.mjs";
import { patchConfig, publicConfig, saveConfig } from "./config.mjs";
import { credentialsConfigured, loadCredentials, normalizeCredentials } from "./credentials.mjs";
import { RolloutCollector, resolveRolloutRoots } from "./rollout-collector.mjs";
import { chooseRoute, prepareCandidates } from "./router.mjs";
import { calculateCostBreakdown, TelemetryStore } from "./telemetry.mjs";
import { getRelayAdapter, relayCapabilities } from "./relay-adapters.mjs";
import { VERSION } from "./version.mjs";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authError(message) {
  return [{ source: "authentication", message: String(message || "AIHub authentication failed") }];
}

function collapseErrors(errors = []) {
  const authentication = errors.find((error) => error.authenticationFailure);
  if (authentication) return authError(authentication.message);
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.source}:${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ source, message }) => ({ source, message }));
}

const PROVIDER_DATA_SOURCES = new Set(["stats", "groups", "rates"]);

function errorSources(errors = []) {
  return new Set(errors.map((error) => String(error?.source || "")).filter(Boolean));
}

// Keep the last complete provider view when one of the AIHub endpoints is
// temporarily unavailable. A partial response must not erase known group
// names, health, models, or rates from the drawer and router.
function mergeProviderSnapshots(previous = [], incoming = [], errors = []) {
  const sources = errorSources(errors);
  const groupsUnavailable = sources.has("groups");
  const statsUnavailable = sources.has("stats");
  const ratesUnavailable = sources.has("rates");
  const previousById = new Map(previous.map((provider) => [String(provider.id), provider]));
  return incoming.map((provider) => {
    const old = previousById.get(String(provider.id));
    if (!old) return provider;
    return {
      ...old,
      ...provider,
      code: provider.code || old.code,
      name: provider.name || old.name,
      multiplier: ratesUnavailable && provider.multiplier == null ? old.multiplier : provider.multiplier ?? old.multiplier,
      status: groupsUnavailable && (!provider.status || provider.status === "observed") ? (old.status || provider.status) : provider.status,
      available: groupsUnavailable && provider.available == null ? old.available : provider.available,
      enabled: groupsUnavailable ? (old.enabled ?? provider.enabled) : provider.enabled,
      models: groupsUnavailable && !provider.models?.length ? (old.models || []) : provider.models,
      modelCheck: groupsUnavailable && provider.modelCheck === "unknown" ? (old.modelCheck || provider.modelCheck) : provider.modelCheck,
      warnings: groupsUnavailable && !provider.warnings?.length ? (old.warnings || []) : provider.warnings,
      ttftMs: statsUnavailable && provider.ttftMs == null ? old.ttftMs : provider.ttftMs,
      outputTokensPerSecond: statsUnavailable && provider.outputTokensPerSecond == null ? old.outputTokensPerSecond : provider.outputTokensPerSecond,
      sampleCount: statsUnavailable && !provider.sampleCount ? old.sampleCount : provider.sampleCount,
      lastSampleAt: statsUnavailable && !provider.lastSampleAt ? old.lastSampleAt : provider.lastSampleAt,
      cacheHitRate: statsUnavailable && provider.cacheHitRate == null ? old.cacheHitRate : provider.cacheHitRate,
      successRate: statsUnavailable && provider.successRate == null ? old.successRate : provider.successRate,
    };
  });
}

function providerTelemetryMetrics(requests = [], providerId) {
  const records = requests.filter((request) => String(request.groupId) === String(providerId));
  const latency = records.map((request) => Number(request.firstByteMs)).filter(Number.isFinite);
  const inputTokens = records.reduce((sum, request) => sum + Math.max(0, Number(request.inputTokens) || 0), 0);
  const cachedTokens = records.reduce((sum, request) => {
    const input = Math.max(0, Number(request.inputTokens) || 0);
    return sum + Math.min(input, Math.max(0, Number(request.cachedTokens) || 0));
  }, 0);
  const completed = records.filter((request) => request.state !== "running");
  const successful = completed.filter((request) => request.outcome !== "error" && (!Number.isFinite(Number(request.status)) || Number(request.status) < 400));
  const models = [...new Set(records.map((request) => request.model).filter((model) => model && model !== "unknown"))];
  const unsupported = records.some((request) => Number(request.status) === 404 && /model.*not supported|not supported.*model/i.test(String(request.error || "")));
  const supported = records.some((request) => request.outcome !== "error" && (!Number.isFinite(Number(request.status)) || Number(request.status) < 400) && request.model && request.model !== "unknown");
  const timestamps = records.map((request) => Date.parse(request.finishedAt || request.startedAt || "")).filter(Number.isFinite);
  return {
    samples: records.length,
    ttftMs: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : null,
    successRate: completed.length ? successful.length / completed.length : null,
    models,
    modelCheck: unsupported ? "unsupported" : supported ? "supported" : "unverified",
    lastSampleAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
  };
}

const HEALTHY_STATUSES = new Set(["available", "healthy", "online", "active", "ok", "ready"]);
const ERROR_STATUSES = new Set(["unavailable", "disabled", "offline", "error", "failed", "down", "cooldown"]);

function ageSeconds(lastSampleAt, now = Date.now()) {
  const timestamp = Date.parse(lastSampleAt || "");
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : null;
}

export function freshnessLabel(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "未采样";
  const age = Math.max(0, Number(seconds));
  if (age < 10) return "刚刚";
  if (age < 60) return `${Math.round(age)}秒前`;
  if (age < 3600) return `${Math.round(age / 60)}分钟前`;
  if (age < 86400) return `${Math.round(age / 3600)}小时前`;
  return `${Math.round(age / 86400)}天前`;
}

export function deriveProviderHealth(provider, local = {}, now = Date.now()) {
  const cooling = provider?.cooldownUntil && Date.parse(provider.cooldownUntil) > now;
  const status = String(provider?.status || "").toLowerCase();
  let state = "unverified";
  let source = "not_observed";
  if (cooling) {
    state = "cooldown";
    source = "local_router";
  } else if (provider?.enabled === false || provider?.available === false || ERROR_STATUSES.has(status)) {
    state = "error";
    source = provider?.available === false || ERROR_STATUSES.has(status) ? "aihub" : "configuration";
  } else if (provider?.available === true || HEALTHY_STATUSES.has(status)) {
    state = "available";
    source = "aihub";
  } else if (local?.samples > 0 && local?.successRate !== null && local?.successRate !== undefined) {
    state = Number(local.successRate) >= 0.5 ? "available" : "error";
    source = "local_requests";
  }
  const labels = { available: "可用", error: "异常", cooldown: "冷却中", unverified: "未检测" };
  return {
    healthState: state,
    healthLabel: labels[state],
    healthSource: source,
    healthDetail: source === "aihub" ? "AIHub 状态" : source === "local_requests" ? `本机 ${local.samples} 个请求` : source === "local_router" ? "本机故障切组" : "接口未提供健康状态",
  };
}

export function deriveProviderModelSupport(provider, local = {}, currentModel = null) {
  const target = String(currentModel || "").trim();
  if (target && local.models?.includes(target)) {
    return local.modelCheck === "unsupported" ? "unsupported" : "supported";
  }
  if (target && Array.isArray(provider?.models) && provider.models.length) {
    return provider.models.includes(target) ? "supported" : "unsupported";
  }
  if (local.modelCheck === "unsupported") return "unsupported";
  if (local.models?.length || provider?.models?.length) return "unverified";
  return "unknown";
}

function localTrend(history, limit = 12) {
  return Array.isArray(history) ? history.slice(-limit).map((point) => ({
    at: point.at,
    ttftMs: Number.isFinite(Number(point.ttftMs)) ? Number(point.ttftMs) : null,
    cacheHitRate: Number.isFinite(Number(point.cacheHitRate)) ? Number(point.cacheHitRate) : null,
    successRate: Number.isFinite(Number(point.successRate)) ? Number(point.successRate) : null,
    outcome: point.outcome || null,
    source: point.source || "local_requests",
  })) : [];
}

function sessionUsable(session, marginMs = 120_000) {
  if (!session?.accessToken) return false;
  if (!session.expiresAt) return true;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > marginMs;
}

export class MonitorService extends EventEmitter {
  constructor({
    config,
    dataDir,
    env = process.env,
    credentials = null,
    credentialSource = null,
    fetchImpl = globalThis.fetch,
    telemetry = new TelemetryStore(),
    rolloutCollector = null,
  }) {
    super();
    this.config = config;
    this.adapter = getRelayAdapter(config.relayAdapter);
    this.dataDir = dataDir;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.credentials = normalizeCredentials(credentials || {
      email: env.AIHUB_EMAIL,
      password: env.AIHUB_PASSWORD,
      accessToken: env.AIHUB_ACCESS_TOKEN,
      refreshToken: env.AIHUB_REFRESH_TOKEN,
      expiresAt: env.AIHUB_ACCESS_TOKEN_EXPIRES_AT,
      cookie: env.AIHUB_COOKIE,
      userAgent: env.AIHUB_USER_AGENT,
    });
    this.credentialSource = credentialSource || env.AIHUB_CREDENTIAL_SOURCE || null;
    this.session = this.credentials.accessToken ? {
      accessToken: this.credentials.accessToken,
      refreshToken: this.credentials.refreshToken,
      expiresAt: this.credentials.expiresAt,
    } : null;
    this.authentication = {
      configured: credentialsConfigured(this.credentials),
      authenticated: false,
      method: this.credentials.email && this.credentials.password ? "login" : this.credentials.accessToken ? "token" : this.credentials.cookie ? "cookie" : null,
      expiresAt: this.session?.expiresAt || null,
      lastAuthenticatedAt: null,
      lastError: null,
    };
    this.telemetry = telemetry;
    this.providers = [];
    this.keys = [];
    this.balance = null;
    this.currentGroupId = null;
    this.routeDecision = null;
    this.lastRefreshAt = null;
    this.providerDataLastGoodAt = null;
    this.providerDataStale = false;
    this.keyDataLastGoodAt = null;
    this.keyDataStale = false;
    this.lastError = null;
    this.credentialError = null;
    this.lastSwitch = null;
    this.lastProxyAt = null;
    this.currentTurn = null;
    this.rolloutError = null;
    this.groupCooldowns = new Map();
    this.providerHistory = new Map();
    this.failoverPromise = null;
    this.running = false;
    this.refreshPromise = null;
    this.timer = null;
    this.telemetry.on("record", (record) => {
      this.recordProviderHistory(record);
      this.emitState();
    });
    this.rollout = rolloutCollector || (config.rolloutEnabled ? new RolloutCollector({
      roots: resolveRolloutRoots(env),
      pollIntervalMs: config.rolloutPollIntervalMs,
      historyFileLimit: config.rolloutHistoryFiles,
    }) : null);
    this.rollout?.on("record", (record) => this.telemetry.add(this.decorateRelayRecord(record)));
    this.rollout?.on("progress", (record) => {
      this.currentTurn = record ? this.decorateRelayRecord(record) : null;
      this.emitState();
    });
    this.rollout?.on("collector-error", (error) => {
      this.rolloutError = error.message;
      this.emitState();
    });
  }

  pricingModel(model) {
    return this.config.modelAliases?.[model] || model;
  }

  decorateRelayRecord(record) {
    if (!record) return record;
    const active = this.providers.find((provider) => String(provider.id) === String(this.currentGroupId));
    const multiplier = active?.multiplier ?? this.config.relayMultiplier ?? 1;
    const pricingModel = this.pricingModel(record.model);
    const breakdown = record.cost == null
      ? calculateCostBreakdown(pricingModel, record, this.config.modelPricing, multiplier)
      : null;
    return {
      ...record,
      relayName: record.relayName || this.config.relayName,
      relayCurrency: record.relayCurrency || this.config.relayCurrency,
      multiplier: record.multiplier ?? multiplier,
      groupName: record.groupName || (this.adapter.id === "generic" ? this.config.relayName : null),
      ...(pricingModel !== record.model ? { pricingModel } : {}),
      ...(breakdown ? { cost: breakdown.chargedCost, costSource: "estimated", costBreakdown: breakdown } : {}),
    };
  }

  client(accessToken = this.session?.accessToken || this.credentials.accessToken) {
    return new AIHubClient({
      baseUrl: this.config.aihubBaseUrl,
      accessToken,
      cookie: this.credentials.cookie,
      userAgent: this.credentials.userAgent,
      fetchImpl: this.fetchImpl,
    });
  }

  setSession(session) {
    this.session = session;
    this.authentication.authenticated = true;
    this.authentication.expiresAt = session?.expiresAt || null;
    this.authentication.lastAuthenticatedAt = new Date().toISOString();
    this.authentication.lastError = null;
  }

  markAuthenticationFailure(error) {
    this.authentication.authenticated = false;
    this.authentication.lastError = error?.message || String(error);
  }

  canRenewSession() {
    return Boolean(
      this.session?.refreshToken ||
      this.credentials.refreshToken ||
      (this.credentials.email && this.credentials.password),
    );
  }

  async authenticatedClient({ forceRenew = false } = {}) {
    if (!this.authentication.configured) return null;
    if (!forceRenew && sessionUsable(this.session)) return this.client(this.session.accessToken);

    const refreshToken = this.session?.refreshToken || this.credentials.refreshToken;
    if (refreshToken) {
      try {
        const session = await this.client("").refreshSession(refreshToken);
        this.setSession(session);
        return this.client(session.accessToken);
      } catch (error) {
        if (!error.authenticationFailure || !(this.credentials.email && this.credentials.password)) throw error;
      }
    }

    if (this.credentials.email && this.credentials.password) {
      const session = await this.client("").login(this.credentials.email, this.credentials.password);
      this.setSession(session);
      return this.client(session.accessToken);
    }

    if (this.credentials.accessToken || this.credentials.cookie) {
      return this.client(this.credentials.accessToken);
    }
    return null;
  }

  async withAuthenticatedClient(operation) {
    let client = await this.authenticatedClient();
    if (!client) throw new Error("AIHub login is not configured");
    try {
      const result = await operation(client);
      this.authentication.authenticated = true;
      this.authentication.lastAuthenticatedAt = new Date().toISOString();
      this.authentication.lastError = null;
      return result;
    } catch (error) {
      if (!error.authenticationFailure || !this.canRenewSession()) throw error;
      client = await this.authenticatedClient({ forceRenew: true });
      const result = await operation(client);
      this.authentication.authenticated = true;
      this.authentication.lastAuthenticatedAt = new Date().toISOString();
      this.authentication.lastError = null;
      return result;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule();
    void this.rollout?.start().catch((error) => {
      this.rolloutError = error.message;
      this.emitState();
    });
    void this.refresh().catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rollout?.stop();
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    if (!this.running) return;
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.config.pollIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  async configure(patch) {
    this.config = patchConfig(this.config, patch);
    this.adapter = getRelayAdapter(this.config.relayAdapter);
    await saveConfig(this.dataDir, this.config);
    this.schedule();
    this.emitState();
    return this.status();
  }

  async reloadCredentials() {
    const credential = await loadCredentials({ env: this.env, dataDir: this.dataDir });
    this.credentials = normalizeCredentials(credential.credentials);
    this.credentialSource = credential.source;
    this.session = this.credentials.accessToken ? {
      accessToken: this.credentials.accessToken,
      refreshToken: this.credentials.refreshToken,
      expiresAt: this.credentials.expiresAt,
    } : null;
    this.authentication = {
      configured: credentialsConfigured(this.credentials),
      authenticated: false,
      method: this.credentials.email && this.credentials.password ? "login" : this.credentials.accessToken ? "token" : this.credentials.cookie ? "cookie" : null,
      expiresAt: this.session?.expiresAt || null,
      lastAuthenticatedAt: null,
      lastError: credential.error || null,
    };
    this.credentialError = credential.error || null;
    return this.refresh({ autoRoute: false });
  }

  async refresh({ autoRoute = true } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        if (this.adapter.id === "generic") {
          this.authentication.authenticated = false;
          this.providers = [];
          this.keys = [];
          this.balance = null;
          this.currentGroupId = null;
          this.routeDecision = null;
          this.lastRefreshAt = new Date().toISOString();
          this.lastError = null;
          return this.status();
        }
        let snapshot;
        if (this.authentication.configured) {
          try {
            let client = await this.authenticatedClient();
            snapshot = await client.refresh(this.config, { includePrivate: true });
            if (snapshot.errors.some((error) => error.authenticationFailure) && this.canRenewSession()) {
              client = await this.authenticatedClient({ forceRenew: true });
              snapshot = await client.refresh(this.config, { includePrivate: true });
            }
            const rejected = snapshot.errors.find((error) => error.authenticationFailure);
            if (rejected) this.markAuthenticationFailure(rejected);
            else {
              this.authentication.authenticated = true;
              this.authentication.lastAuthenticatedAt = new Date().toISOString();
              this.authentication.lastError = null;
            }
          } catch (error) {
            this.markAuthenticationFailure(error);
            snapshot = await this.client("").refresh(this.config, { includePrivate: false });
            snapshot.errors.push({ source: "authentication", message: error.message, authenticationFailure: true });
          }
        } else {
          snapshot = await this.client("").refresh(this.config, { includePrivate: false });
        }
        const sources = errorSources(snapshot.errors);
        const providerErrors = [...sources].some((source) => PROVIDER_DATA_SOURCES.has(source));
        const keyError = sources.has("keys");
        if (snapshot.providers.length > 0) {
          this.providers = mergeProviderSnapshots(this.providers, snapshot.providers, snapshot.errors);
          if (!providerErrors) this.providerDataLastGoodAt = new Date().toISOString();
          this.providerDataStale = providerErrors;
        } else if (!providerErrors) {
          this.providers = [];
          this.providerDataLastGoodAt = new Date().toISOString();
          this.providerDataStale = false;
        } else if (this.providers.length > 0) {
          this.providerDataStale = true;
        }
        if (snapshot.keys.length > 0 || !keyError) {
          this.keys = snapshot.keys;
          if (!keyError) this.keyDataLastGoodAt = new Date().toISOString();
          this.keyDataStale = keyError;
        } else if (this.keys.length > 0) {
          this.keyDataStale = true;
        }
        if (snapshot.balance) {
          const previousBalance = this.balance;
          const fetchedAt = new Date().toISOString();
          if (previousBalance && Number.isFinite(Number(previousBalance.amount)) && Number.isFinite(Number(snapshot.balance.amount))) {
            const delta = Number(previousBalance.amount) - Number(snapshot.balance.amount);
            if (delta > 0 && previousBalance.fetchedAt) this.telemetry.applyBalanceDelta(delta, { since: previousBalance.fetchedAt });
          }
          this.balance = { ...snapshot.balance, fetchedAt };
        }
        else if (!this.authentication.authenticated) this.balance = null;
        this.currentGroupId = this.authentication.authenticated
          ? (snapshot.currentGroupId ?? (keyError ? this.currentGroupId : null))
          : null;
        const latestModel = this.currentTurn?.model || this.telemetry.snapshot().requests[0]?.model || null;
        const cooldownIds = [...this.groupCooldowns.entries()].filter(([, until]) => until > Date.now()).map(([id]) => id);
        this.routeDecision = chooseRoute(this.providers, this.config, { currentGroupId: this.currentGroupId, model: latestModel, cooldownIds });
        this.lastRefreshAt = new Date().toISOString();
        this.lastError = snapshot.errors.length
          ? collapseErrors(snapshot.errors)
          : this.credentialError
            ? [{ source: "credential", message: this.credentialError }]
            : null;
        if (
          autoRoute &&
          this.config.routingEnabled &&
          this.config.managedKeyIds.length > 0 &&
          this.authentication.authenticated &&
          this.routeDecision.shouldSwitch &&
          this.routeDecision.selected
        ) {
          await this.switchGroup(this.routeDecision.selected.id, `automatic:${this.routeDecision.reason}`);
        }
      } catch (error) {
        if (error.authenticationFailure) this.markAuthenticationFailure(error);
        this.lastError = [{ source: "refresh", message: error.message }];
        this.lastRefreshAt = new Date().toISOString();
      } finally {
        this.refreshPromise = null;
        this.emitState();
      }
      return this.status();
    })();
    return this.refreshPromise;
  }

  async switchGroup(groupId, reason = "manual") {
    if (this.adapter.id !== "aihub") throw new Error("通用中转站未提供 AIHub 分组切换接口");
    const candidate = prepareCandidates(this.providers, this.config).find((provider) => String(provider.id) === String(groupId));
    if (!candidate) throw new Error(`Unknown AIHub group: ${groupId}`);
    if (!candidate.switchEligible) throw new Error(`Group ${groupId} cannot be switched: ${candidate.switchExcludedReasons.join(", ")}`);
    if (!this.config.managedKeyIds.length) throw new Error("No managed AIHub Key IDs are configured");
    if (!this.authentication.configured) throw new Error("AIHub login is not configured");
    await this.withAuthenticatedClient((client) => client.switchManagedKeys(this.config.managedKeyIds, candidate.id));
    this.currentGroupId = candidate.id;
    this.lastSwitch = {
      at: new Date().toISOString(),
      groupId: candidate.id,
      groupName: candidate.name,
      reason,
    };
    this.groupCooldowns.delete(String(candidate.id));
    const cooldownIds = [...this.groupCooldowns.entries()].filter(([, until]) => until > Date.now()).map(([id]) => id);
    this.routeDecision = chooseRoute(this.providers, this.config, { currentGroupId: this.currentGroupId, cooldownIds });
    this.emitState();
    return this.lastSwitch;
  }

  async failover({ attemptedGroupIds = [], statusCode = null, error = null } = {}) {
    if (this.adapter.id !== "aihub") return { switched: false, reason: "generic_adapter" };
    if (this.failoverPromise) return this.failoverPromise;
    this.failoverPromise = (async () => {
      if (!this.providers.length) await this.refresh({ autoRoute: false });
      const now = Date.now();
      for (const [id, until] of this.groupCooldowns) {
        if (until <= now) this.groupCooldowns.delete(id);
      }
      if (this.currentGroupId !== null) {
        this.groupCooldowns.set(String(this.currentGroupId), now + this.config.groupCooldownSeconds * 1000);
      }
      const cooldownIds = [...this.groupCooldowns.keys()];
      const attempted = [...new Set([...attemptedGroupIds, this.currentGroupId].filter((value) => value !== null))];
      const model = this.currentTurn?.model || this.telemetry.snapshot().requests[0]?.model || null;
      const decision = chooseRoute(this.providers, this.config, {
        currentGroupId: this.currentGroupId,
        excludeIds: attempted,
        cooldownIds,
        economyFailover: this.config.mode === "economy",
        model,
      });
      if (!decision.selected) return { switched: false, reason: decision.reason };
      await this.switchGroup(decision.selected.id, `failover:${statusCode || error || "network"}`);
      if (this.config.switchPropagationDelayMs) await wait(this.config.switchPropagationDelayMs);
      return { switched: true, group: decision.selected, reason: decision.reason };
    })().finally(() => {
      this.failoverPromise = null;
    });
    return this.failoverPromise;
  }

  recordRequest(record) {
    this.lastProxyAt = new Date().toISOString();
    return this.telemetry.add(this.decorateRelayRecord({ source: "proxy", ...record }));
  }

  recordProviderHistory(record) {
    const groupId = record?.groupId;
    if (groupId === null || groupId === undefined || groupId === "") return;
    const key = String(groupId);
    const at = record.finishedAt || record.startedAt || new Date().toISOString();
    const input = Math.max(0, Number(record.inputTokens) || 0);
    const cached = Math.min(input, Math.max(0, Number(record.cachedTokens) || 0));
    const complete = record.state !== "running";
    const success = complete && record.outcome !== "error" && (!Number.isFinite(Number(record.status)) || Number(record.status) < 400);
    const point = {
      id: record.id || null,
      at,
      ttftMs: Number.isFinite(Number(record.firstByteMs)) ? Number(record.firstByteMs) : null,
      cacheHitRate: input > 0 ? cached / input : null,
      successRate: complete ? (success ? 1 : 0) : null,
      outcome: record.outcome || (complete ? "success" : "running"),
      source: record.source || "local_requests",
    };
    const history = this.providerHistory.get(key) || [];
    const existing = point.id ? history.findIndex((item) => item.id === point.id) : -1;
    if (existing >= 0) history[existing] = point;
    else history.push(point);
    if (history.length > 24) history.splice(0, history.length - 24);
    this.providerHistory.set(key, history);
  }

  emitState() {
    this.emit("state", this.status());
  }

  status() {
    const routeCandidates = new Map((this.routeDecision?.candidates || []).map((candidate) => [String(candidate.id), candidate]));
    const config = {
      ...publicConfig(this.config, this.env),
      credentialsConfigured: this.authentication.configured,
      credentialsValid: this.authentication.authenticated,
      credentialSource: this.credentialSource,
    };
    return {
      config,
      runtime: {
        version: VERSION,
        relay: relayCapabilities(this.adapter.id),
        running: this.running,
        dashboardUrl: `http://${this.config.host}:${this.config.port}/`,
        proxyUrl: `http://${this.config.host}:${this.config.port}/v1`,
        lastRefreshAt: this.lastRefreshAt,
        providerDataLastGoodAt: this.providerDataLastGoodAt,
        providerDataStale: this.providerDataStale,
        keyDataLastGoodAt: this.keyDataLastGoodAt,
        keyDataStale: this.keyDataStale,
        lastError: this.lastError,
        lastSwitch: this.lastSwitch,
        telemetryMode: this.lastProxyAt ? "rollout+proxy" : "rollout-only",
        proxyObserved: Boolean(this.lastProxyAt),
        lastProxyAt: this.lastProxyAt,
        auth: { ...this.authentication },
        rollout: this.rollout?.status() || { enabled: false, running: false, lastError: this.rolloutError },
      },
      balance: this.balance,
      providers: this.providers.map((provider) => {
        const candidate = routeCandidates.get(String(provider.id));
        const local = providerTelemetryMetrics(this.telemetry.snapshot().requests, provider.id);
        const models = provider.models?.length ? provider.models : local.models;
        const modelCheck = provider.modelCheck && provider.modelCheck !== "unknown" ? provider.modelCheck : local.modelCheck;
        const currentModel = this.currentTurn?.model || this.telemetry.snapshot().requests[0]?.model || null;
        const lastSampleAt = local.lastSampleAt || provider.lastSampleAt || null;
        const freshnessSeconds = ageSeconds(lastSampleAt);
        const freshness = freshnessLabel(freshnessSeconds);
        const health = deriveProviderHealth(provider, local);
        const modelSupport = deriveProviderModelSupport(provider, local, currentModel);
        const speedValueMs = local.ttftMs ?? provider.ttftMs;
        const cacheHitRate = provider.cacheHitRate ?? local.cacheHitRate;
        const successRate = provider.successRate ?? local.successRate;
        return {
          ...provider,
          ttftMs: provider.ttftMs ?? local.ttftMs,
          observedTtftMs: local.ttftMs,
          speedValueMs,
          speedSource: local.ttftMs !== null ? "local_requests" : Number.isFinite(Number(provider.ttftMs)) ? "aihub_public_ttft" : "not_observed",
          localSampleCount: local.samples,
          cacheHitRate,
          cacheHitRateSource: provider.cacheHitRate !== null && provider.cacheHitRate !== undefined ? "aihub" : local.cacheHitRate !== null ? "local_requests" : local.samples ? "local_unavailable" : "aihub_unavailable",
          successRate,
          successRateSource: provider.successRate !== null && provider.successRate !== undefined ? "aihub" : local.successRate !== null ? "local_requests" : local.samples ? "local_unavailable" : "aihub_unavailable",
          observedModels: local.models,
          models,
          modelCheck,
          modelCheckSource: provider.models?.length || provider.modelCheck !== "unknown" ? "aihub" : local.models.length ? "local_requests" : "aihub_unavailable",
          currentModel,
          modelSupport,
          modelSupportSource: provider.models?.length ? "aihub" : local.models.length ? "local_requests" : "aihub_unavailable",
          ...health,
          lastSampleAt,
          freshnessSeconds,
          freshness,
          trend: localTrend(this.providerHistory.get(String(provider.id))),
          confidence: candidate?.confidence ?? null,
          eligible: candidate?.eligible ?? false,
          switchEligible: candidate?.switchEligible ?? false,
          excludedReasons: candidate?.excludedReasons || [],
          switchExcludedReasons: candidate?.switchExcludedReasons || [],
          active: String(provider.id) === String(this.currentGroupId),
          cooldownUntil: this.groupCooldowns.has(String(provider.id))
            ? new Date(this.groupCooldowns.get(String(provider.id))).toISOString()
            : null,
        };
      }),
      keys: this.keys.map((key) => ({ ...key, managed: this.config.managedKeyIds.includes(key.id) })),
      currentGroupId: this.currentGroupId,
      routeDecision: this.routeDecision,
      currentTurn: this.currentTurn,
      telemetry: this.telemetry.snapshot(),
    };
  }
}
