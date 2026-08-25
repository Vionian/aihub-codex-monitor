import { EventEmitter } from "node:events";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageFrom(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens),
    cachedTokens: number(usage.cached_input_tokens ?? usage.cachedTokens),
    cacheWriteTokens: number(usage.cache_write_input_tokens ?? usage.cacheWriteTokens),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens),
    reasoningTokens: number(usage.reasoning_output_tokens ?? usage.reasoningTokens),
    totalTokens: number(usage.total_tokens ?? usage.totalTokens),
  };
}

function usageDelta(current, baseline) {
  const result = {};
  for (const key of Object.keys(ZERO_USAGE)) {
    const delta = number(current[key]) - number(baseline[key]);
    result[key] = delta >= 0 ? delta : number(current[key]);
  }
  return result;
}

function isoFrom(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(value || fallback || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function statusFromError(error) {
  if (!error) return 200;
  const message = String(error.message || error);
  const match = message.match(/(?:status|http(?:\s+status)?)[^0-9]{0,12}([45][0-9]{2})/i) || message.match(/\b([45][0-9]{2})\b/);
  return match ? Number(match[1]) : 0;
}

function redactError(error) {
  if (!error) return null;
  return String(error.message || error)
    .replace(/(bearer|token|cookie|password|api[-_ ]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 1000);
}

export function resolveRolloutRoots(env = process.env) {
  const profile = env.USERPROFILE || env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(profile, ".codex");
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

async function discoverFiles(roots, limit) {
  const entries = [];
  for (const root of roots) {
    try {
      const names = await readdir(root, { recursive: true });
      for (const name of names) {
        if (!String(name).toLowerCase().endsWith(".jsonl")) continue;
        const file = path.join(root, name);
        try {
          const details = await stat(file);
          if (details.isFile()) entries.push({ file, size: details.size, modifiedMs: details.mtimeMs });
        } catch { /* A rollout may be rotated between listing and stat. */ }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return entries.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit);
}

function newFileState(file) {
  return {
    file,
    offset: 0,
    remainder: "",
    sessionId: path.basename(file, ".jsonl"),
    sessionMetaSeen: false,
    modelProvider: null,
    lastUsage: { ...ZERO_USAGE },
    activeTurnId: null,
    turns: new Map(),
  };
}

export class RolloutCollector extends EventEmitter {
  constructor({ roots = resolveRolloutRoots(), pollIntervalMs = 1000, historyFileLimit = 24 } = {}) {
    super();
    this.roots = roots;
    this.pollIntervalMs = pollIntervalMs;
    this.historyFileLimit = historyFileLimit;
    this.files = new Map();
    this.running = false;
    this.timer = null;
    this.scanPromise = null;
    this.lastEventAt = null;
    this.lastError = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.scan();
    this.timer = setInterval(() => void this.scan(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.#scan().catch((error) => {
      this.lastError = error.message;
      this.emit("collector-error", error);
    }).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async #scan() {
    const discovered = await discoverFiles(this.roots, this.historyFileLimit);
    // Parse older files first so TelemetryStore's newest-first ordering remains global.
    for (const entry of [...discovered].reverse()) {
      const state = this.files.get(entry.file) || newFileState(entry.file);
      this.files.set(entry.file, state);
      if (entry.size < state.offset) Object.assign(state, newFileState(entry.file));
      if (entry.size > state.offset) await this.#readAppend(state, entry.size);
    }
    this.lastError = null;
  }

  async #readAppend(state, size) {
    const length = size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(state.file, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      const text = state.remainder + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/);
      state.remainder = lines.pop() || "";
      for (const line of lines) this.#consumeLine(state, line);
    } finally {
      await handle.close();
    }
  }

  #turn(state, turnId, timestamp) {
    const id = String(turnId || state.activeTurnId || "unknown");
    if (!state.turns.has(id)) {
      state.turns.set(id, {
        turnId: id,
        sessionId: state.sessionId,
        startedAt: isoFrom(timestamp),
        baselineUsage: { ...state.lastUsage },
        model: "unknown",
        reasoningEffort: "default",
        contextWindow: null,
        contextTokens: null,
      });
    }
    return state.turns.get(id);
  }

  #progress(state, turn, timestamp) {
    const usage = usageDelta(state.lastUsage, turn.baselineUsage);
    const record = {
      id: `rollout:${turn.sessionId}:${turn.turnId}`,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      startedAt: turn.startedAt,
      updatedAt: isoFrom(timestamp),
      model: turn.model,
      reasoningEffort: turn.reasoningEffort,
      contextWindow: turn.contextWindow,
      contextTokens: turn.contextTokens,
      source: "codex_rollout",
      state: "running",
      ...usage,
    };
    this.lastEventAt = record.updatedAt;
    this.emit("progress", record);
  }

  #consumeLine(state, line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const payload = event?.payload || {};
    const type = event?.type === "event_msg" ? payload.type : event?.type;
    const timestamp = event?.timestamp;

    if (type === "session_meta") {
      // Forked desktop rollouts can embed the parent's complete history after the
      // fork metadata. The first session_meta owns this file; later entries are
      // historical data and must not reassign live turns to the parent session.
      if (!state.sessionMetaSeen) {
        state.sessionId = String(payload.id || payload.session_id || state.sessionId);
        state.modelProvider = payload.model_provider || payload.modelProvider || null;
        state.sessionMetaSeen = true;
      }
      return;
    }
    if (type === "task_started") {
      const turn = this.#turn(state, payload.turn_id, payload.started_at || timestamp);
      turn.startedAt = isoFrom(payload.started_at, timestamp);
      turn.baselineUsage = { ...state.lastUsage };
      turn.contextWindow = number(payload.model_context_window) || null;
      state.activeTurnId = turn.turnId;
      this.#progress(state, turn, timestamp);
      return;
    }
    if (type === "turn_context") {
      const turn = this.#turn(state, payload.turn_id, timestamp);
      turn.model = String(payload.model || turn.model || "unknown");
      turn.reasoningEffort = String(payload.effort || payload.reasoning_effort || turn.reasoningEffort || "default");
      turn.contextWindow = number(payload.model_context_window) || turn.contextWindow;
      state.activeTurnId = turn.turnId;
      this.#progress(state, turn, timestamp);
      return;
    }
    if (type === "token_count") {
      const total = payload.info?.total_token_usage;
      const latest = payload.info?.last_token_usage;
      if (total) state.lastUsage = usageFrom(total);
      const turn = state.turns.get(String(state.activeTurnId));
      if (turn) {
        if (latest) turn.contextTokens = usageFrom(latest).inputTokens || turn.contextTokens;
        this.#progress(state, turn, timestamp);
      }
      return;
    }
    if (type !== "task_complete") return;

    const turn = this.#turn(state, payload.turn_id, payload.started_at || timestamp);
    const usage = usageDelta(state.lastUsage, turn.baselineUsage);
    const error = redactError(payload.error);
    const record = {
      id: `rollout:${turn.sessionId}:${turn.turnId}`,
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      modelProvider: state.modelProvider,
      startedAt: isoFrom(payload.started_at, turn.startedAt),
      finishedAt: isoFrom(payload.completed_at, timestamp),
      endpoint: null,
      model: turn.model,
      reasoningEffort: turn.reasoningEffort,
      contextWindow: turn.contextWindow,
      contextTokens: turn.contextTokens,
      groupId: null,
      groupName: null,
      multiplier: null,
      status: statusFromError(payload.error),
      outcome: error ? "error" : "completed",
      firstByteMs: number(payload.time_to_first_token_ms) || null,
      totalMs: number(payload.duration_ms) || null,
      failovers: [],
      error,
      cost: null,
      costSource: "unavailable",
      source: "codex_rollout",
      sources: {
        identity: "codex_rollout",
        usage: "codex_rollout",
        latency: "codex_rollout",
        cost: null,
        group: null,
      },
      ...usage,
    };
    state.turns.delete(turn.turnId);
    if (state.activeTurnId === turn.turnId) state.activeTurnId = null;
    this.lastEventAt = record.finishedAt;
    this.emit("record", record);
    this.emit("progress", null);
  }

  status() {
    return {
      enabled: true,
      running: this.running,
      filesTracked: this.files.size,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
    };
  }
}
