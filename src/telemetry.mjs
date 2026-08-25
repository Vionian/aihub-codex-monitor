import { EventEmitter } from "node:events";

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function findUsage(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.usage,
    value.response?.usage,
    value.data?.usage,
    value.result?.usage,
    value.data?.response?.usage,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object") || null;
}

function findCost(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [value, value.usage, value.billing, value.response, value.response?.usage, value.response?.billing, value.data, value.data?.usage];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    for (const key of [
      "cost", "request_cost", "total_cost", "response_cost", "charged", "charged_amount",
      "cost_usd", "totalCost", "requestCost", "credits_used", "creditsUsed",
    ]) {
      const result = finiteNumber(candidate[key]);
      if (result !== null && result >= 0) return result;
    }
  }
  return null;
}

export function normalizeUsage(value) {
  const usage = findUsage(value) || {};
  const inputTokens = finiteNumber(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const outputTokens = finiteNumber(usage.output_tokens ?? usage.completion_tokens) || 0;
  const cachedTokens = finiteNumber(
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cached_tokens,
  ) || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: finiteNumber(usage.total_tokens) ?? inputTokens + outputTokens,
    cachedTokens,
  };
}

export function calculateCostBreakdown(model, usage, pricingTable, multiplier = 1) {
  const pricing = pricingTable?.[model];
  if (!pricing) return null;
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(usage.cachedTokens) || 0));
  const uncachedInputTokens = inputTokens - cachedTokens;
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
  if (inputTokens === 0 && outputTokens === 0) return null;
  const inputCost = uncachedInputTokens * Number(pricing.inputPerMillion || 0) / 1_000_000;
  const cachedInputCost = cachedTokens * Number(pricing.cachedInputPerMillion || 0) / 1_000_000;
  const outputCost = outputTokens * Number(pricing.outputPerMillion || 0) / 1_000_000;
  const baseCost = inputCost + cachedInputCost + outputCost;
  const rate = Number(multiplier);
  const chargedCost = baseCost * (Number.isFinite(rate) && rate >= 0 ? rate : 1);
  return Number.isFinite(chargedCost) ? {
    inputTokens: uncachedInputTokens,
    cachedTokens,
    outputTokens,
    inputCost,
    cachedInputCost,
    outputCost,
    originalCost: baseCost,
    multiplier: Number.isFinite(rate) && rate >= 0 ? rate : 1,
    chargedCost: Math.round(chargedCost * 1e12) / 1e12,
  } : null;
}

export function calculateCost(model, usage, pricingTable, multiplier = 1) {
  return calculateCostBreakdown(model, usage, pricingTable, multiplier)?.chargedCost ?? null;
}

function costFromHeaders(headers) {
  for (const name of [
    "x-aihub-cost", "x-aihub-request-cost", "x-aihub-response-cost", "x-aihub-total-cost",
    "x-request-cost", "x-response-cost", "x-total-cost", "x-cost", "x-usage-cost",
    "x-billing-cost", "x-oneapi-cost", "x-credits-used",
  ]) {
    const value = finiteNumber(headers.get(name));
    if (value !== null && value >= 0) return value;
  }
  return null;
}

export function createResponseInspector({ model, pricingTable, headers, multiplier = 1 }) {
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";
  let usage = normalizeUsage({});
  let bodyCost = null;
  const headerCost = costFromHeaders(headers);

  const inspectObject = (value) => {
    const nextUsage = normalizeUsage(value);
    if (nextUsage.totalTokens > 0) usage = nextUsage;
    const nextCost = findCost(value);
    if (nextCost !== null) bodyCost = nextCost;
  };

  const consumeLines = () => {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload || payload === "[DONE]") continue;
      try { inspectObject(JSON.parse(payload)); } catch { /* Partial or non-JSON SSE event. */ }
    }
  };

  return {
    consume(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      if (collected.length < 2_000_000) collected += text.slice(0, 2_000_000 - collected.length);
      buffer += text;
      consumeLines();
    },
    finish() {
      buffer += decoder.decode();
      consumeLines();
      try { inspectObject(JSON.parse(collected)); } catch { /* Streaming responses are not a single JSON value. */ }
    const estimatedBreakdown = calculateCostBreakdown(model, usage, pricingTable, multiplier);
    const estimatedCost = estimatedBreakdown?.chargedCost ?? null;
      const cost = headerCost ?? bodyCost ?? estimatedCost;
      const costSource = headerCost !== null
        ? "upstream_header"
        : bodyCost !== null
          ? "upstream_body"
          : estimatedCost !== null
            ? "estimated"
            : "unavailable";
      return { ...usage, cost, costSource, ...(estimatedBreakdown ? { costBreakdown: estimatedBreakdown } : {}) };
    },
  };
}

export class TelemetryStore extends EventEmitter {
  constructor(limit = 200) {
    super();
    this.limit = limit;
    this.requests = [];
    this.totals = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  }

  add(record) {
    let normalized = {
      ...record,
      inputTokens: Number(record.inputTokens || 0),
      outputTokens: Number(record.outputTokens || 0),
      totalTokens: Number(record.totalTokens || 0),
      cachedTokens: Number(record.cachedTokens || 0),
      cacheWriteTokens: Number(record.cacheWriteTokens || 0),
      reasoningTokens: Number(record.reasoningTokens || 0),
      cost: record.cost === null || record.cost === undefined ? null : Number(record.cost),
      costSource: record.costSource || (record.cost === null || record.cost === undefined ? "unavailable" : "reported"),
      source: record.source || "unknown",
    };
    if (normalized.source === "codex_rollout" && normalized.finishedAt) {
      const started = Date.parse(normalized.startedAt) - 2000;
      const finished = Date.parse(normalized.finishedAt) + 2000;
      const proxyRecords = this.requests.filter((item) => {
        const timestamp = Date.parse(item.startedAt);
        return item.source === "proxy" && item.model === normalized.model && timestamp >= started && timestamp <= finished;
      });
      if (proxyRecords.length) {
        const chronological = [...proxyRecords].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
        const priced = proxyRecords.filter((item) => Number.isFinite(item.cost));
        const groups = [...new Set(chronological.map((item) => item.groupName || item.groupId).filter(Boolean))];
        const latestProxy = chronological.at(-1);
        normalized = {
          ...normalized,
          endpoint: latestProxy.endpoint,
          groupId: latestProxy.groupId,
          groupName: groups.length > 1 ? groups.join(" -> ") : latestProxy.groupName,
          multiplier: latestProxy.multiplier,
          cost: priced.length ? priced.reduce((sum, item) => sum + item.cost, 0) : null,
          costSource: priced.length === 1 ? priced[0].costSource : priced.length ? "proxy_aggregate" : "unavailable",
          costBreakdown: priced.length === 1 ? priced[0].costBreakdown : null,
          failovers: proxyRecords.flatMap((item) => item.failovers || []),
          source: "combined",
          sources: {
            ...(normalized.sources || {}),
            cost: priced.length ? "proxy" : null,
            group: latestProxy.groupId === null || latestProxy.groupId === undefined ? null : "proxy",
          },
        };
        for (const proxy of proxyRecords) this.#remove(proxy, { decrementRequests: true });
      }
    }
    const existingIndex = normalized.id ? this.requests.findIndex((item) => item.id === normalized.id) : -1;
    if (existingIndex >= 0) {
      const existing = this.requests[existingIndex];
      this.totals.inputTokens -= existing.inputTokens;
      this.totals.outputTokens -= existing.outputTokens;
      this.totals.totalTokens -= existing.totalTokens;
      if (Number.isFinite(existing.cost)) this.totals.cost -= existing.cost;
      this.requests.splice(existingIndex, 1);
    } else {
      this.totals.requests += 1;
    }
    this.requests.unshift(normalized);
    if (this.requests.length > this.limit) this.requests.length = this.limit;
    this.totals.inputTokens += normalized.inputTokens;
    this.totals.outputTokens += normalized.outputTokens;
    this.totals.totalTokens += normalized.totalTokens;
    if (Number.isFinite(normalized.cost)) this.totals.cost += normalized.cost;
    this.emit("record", normalized);
    return normalized;
  }

  #remove(record, { decrementRequests = false } = {}) {
    const index = this.requests.indexOf(record);
    if (index >= 0) this.requests.splice(index, 1);
    this.totals.inputTokens -= record.inputTokens;
    this.totals.outputTokens -= record.outputTokens;
    this.totals.totalTokens -= record.totalTokens;
    if (Number.isFinite(record.cost)) this.totals.cost -= record.cost;
    if (decrementRequests) this.totals.requests = Math.max(0, this.totals.requests - 1);
  }

  snapshot() {
    return { requests: this.requests, totals: this.totals };
  }

  applyBalanceDelta(amount, { since = null } = {}) {
    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta <= 0) return false;
    const sinceMs = since ? Date.parse(since) : -Infinity;
    const candidates = this.requests
      .filter((item) => item.cost === null && ["proxy", "combined"].includes(item.source))
      .filter((item) => !Number.isFinite(sinceMs) || Date.parse(item.startedAt || "") >= sinceMs)
      .filter((item) => item.outcome !== "error" && (!Number.isFinite(Number(item.status)) || Number(item.status) < 400));
    if (!candidates.length) return false;
    const totalTokens = candidates.reduce((sum, item) => sum + Math.max(1, Number(item.totalTokens) || 0), 0);
    let remaining = delta;
    for (const [index, item] of candidates.entries()) {
      const share = index === candidates.length - 1
        ? remaining
        : delta * (Math.max(1, Number(item.totalTokens) || 0) / totalTokens);
      item.cost = Math.max(0, share);
      item.costSource = "balance_delta";
      item.sources = { ...(item.sources || {}), cost: "balance_delta" };
      remaining -= share;
      this.totals.cost += item.cost;
    }
    this.emit("record", candidates[0]);
    return true;
  }
}
