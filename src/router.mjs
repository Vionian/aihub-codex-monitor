export const MODE_WEIGHTS = Object.freeze({
  economy: { price: 0.9, speed: 0.1 },
  balanced: { price: 0.5, speed: 0.5 },
  speed: { price: 0.1, speed: 0.9 },
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeConfidence({ sampleCount, lastSampleAt }, now, maximumStatusAgeSeconds) {
  const count = Math.max(0, finite(sampleCount) || 0);
  const timestamp = Date.parse(lastSampleAt || "");
  if (!Number.isFinite(timestamp)) return 0;
  const ageSeconds = Math.max(0, (now - timestamp) / 1000);
  const halfLife = Math.max(1, maximumStatusAgeSeconds / 2);
  const freshness = Math.exp((-Math.log(2) * ageSeconds) / halfLife);
  const volume = 1 - Math.exp(-count / 20);
  return Math.max(0, Math.min(1, freshness * volume));
}

export function prepareCandidates(groups, config, { now = Date.now(), excludeIds = [], cooldownIds = [], model = null } = {}) {
  const excluded = new Set(excludeIds.map(String));
  const cooling = new Set(cooldownIds.map(String));
  const blacklisted = new Set((config.blacklistedGroupIds || []).map(String));
  return groups.map((group) => {
    const multiplier = finite(group.multiplier);
    const latency = finite(group.ttftMs);
    const sampleTime = Date.parse(group.lastSampleAt || "");
    const ageSeconds = Number.isFinite(sampleTime) ? (now - sampleTime) / 1000 : Infinity;
    const confidence = computeConfidence(group, now, config.maximumStatusAgeSeconds);
    const reasons = [];
    if (excluded.has(String(group.id))) reasons.push("attempted");
    if (cooling.has(String(group.id))) reasons.push("cooldown");
    if (blacklisted.has(String(group.id))) reasons.push("blacklisted");
    if (group.enabled === false) reasons.push("disabled");
    if (group.available === false) reasons.push("unavailable");
    if (multiplier === null || multiplier < config.minimumMultiplier || multiplier > config.maximumMultiplier) reasons.push("multiplier");
    if (latency === null || latency <= 0) reasons.push("latency");
    if (!Number.isFinite(ageSeconds) || ageSeconds > config.maximumStatusAgeSeconds || ageSeconds < -60) reasons.push("stale");
    if (confidence < config.minimumConfidence) reasons.push("confidence");
    if (model && group.models?.length && !group.models.includes(model)) reasons.push("model");
    const switchExcludedReasons = [];
    if (blacklisted.has(String(group.id))) switchExcludedReasons.push("blacklisted");
    if (group.enabled === false) switchExcludedReasons.push("disabled");
    if (group.available === false) switchExcludedReasons.push("unavailable");
    return {
      ...group,
      multiplier,
      ttftMs: latency,
      confidence,
      conservativeLatencyMs: latency === null ? null : latency * (1 + config.confidenceImpact * (1 - confidence)),
      eligible: reasons.length === 0,
      excludedReasons: reasons,
      switchEligible: switchExcludedReasons.length === 0,
      switchExcludedReasons,
      score: null,
      pricePremiumRatio: null,
      speedupRatio: null,
    };
  });
}

function stableSort(candidates) {
  return [...candidates].sort((a, b) =>
    a.multiplier - b.multiplier ||
    a.conservativeLatencyMs - b.conservativeLatencyMs ||
    Number(a.id) - Number(b.id),
  );
}

export function chooseRoute(groups, config, options = {}) {
  const prepared = prepareCandidates(groups, config, options);
  const eligible = prepared.filter((candidate) => candidate.eligible);
  if (!eligible.length) {
    return { selected: null, shouldSwitch: false, reason: "no_eligible_group", candidates: prepared };
  }

  if (options.economyFailover) {
    const selected = stableSort(eligible)[0];
    return {
      selected,
      shouldSwitch: String(selected.id) !== String(options.currentGroupId ?? ""),
      reason: "economy_failover",
      candidates: prepared,
    };
  }

  const weights = MODE_WEIGHTS[config.mode] || MODE_WEIGHTS.balanced;
  const baseline = stableSort(eligible)[0];
  const zeroPrice = baseline.multiplier === 0;
  const scored = eligible.map((candidate) => {
    let pricePremiumRatio;
    let speedupRatio;
    let score;
    if (zeroPrice) {
      pricePremiumRatio = candidate.multiplier === 0 ? 0 : Infinity;
      speedupRatio = baseline.conservativeLatencyMs / candidate.conservativeLatencyMs - 1;
      score = candidate.multiplier === 0 ? speedupRatio : -Infinity;
    } else {
      pricePremiumRatio = (candidate.multiplier - baseline.multiplier) / baseline.multiplier;
      speedupRatio = baseline.conservativeLatencyMs / candidate.conservativeLatencyMs - 1;
      score = weights.speed * speedupRatio - weights.price * pricePremiumRatio;
    }
    return { ...candidate, pricePremiumRatio, speedupRatio, score };
  });

  scored.sort((a, b) =>
    b.score - a.score ||
    a.multiplier - b.multiplier ||
    a.conservativeLatencyMs - b.conservativeLatencyMs ||
    Number(a.id) - Number(b.id),
  );
  let selected = scored[0];
  const current = scored.find((candidate) => String(candidate.id) === String(options.currentGroupId ?? ""));
  let reason = `${config.mode}_best_score`;
  if (current && selected.id !== current.id && selected.score - current.score <= config.groupStickiness) {
    selected = current;
    reason = "group_stickiness";
  }

  const byId = new Map(scored.map((candidate) => [String(candidate.id), candidate]));
  return {
    selected,
    shouldSwitch: String(selected.id) !== String(options.currentGroupId ?? ""),
    reason,
    candidates: prepared.map((candidate) => byId.get(String(candidate.id)) || candidate),
  };
}
