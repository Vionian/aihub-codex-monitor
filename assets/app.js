(() => {
  "use strict";

  let state = null;
  let currentView = "overview";
  let toastTimer = null;
  const params = new URLSearchParams(location.search);
  const initialLayout = params.get("layout") === "vertical" ? "vertical" : (localStorage.getItem("aihub-monitor-layout") || "horizontal");
  document.body.dataset.layout = initialLayout;

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "--").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const present = (value) => value !== null && value !== undefined && value !== "";
  const number = (value, digits = 0) => present(value) && Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "--";
  const money = (value) => {
    if (!present(value) || !Number.isFinite(Number(value))) return "--";
    const currency = state?.config?.relayCurrency || "USD";
    return `${currency === "USD" ? "$" : `${currency} `}${Number(value).toFixed(6)}`;
  };
  const time = (value) => {
    if (!present(value) || !Number.isFinite(Number(value))) return "--";
    const milliseconds = Number(value);
    return milliseconds >= 1000 ? `${number(milliseconds / 1000, 2)}s` : `${number(milliseconds, 0)}ms`;
  };
  const percent = (value) => present(value) && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "--";
  const uncachedInput = (record) => {
    const input = Math.max(0, Number(record?.inputTokens) || 0);
    return input - Math.min(input, Math.max(0, Number(record?.cachedTokens) || 0));
  };
  const costDetail = (record) => {
    const detail = record?.costBreakdown;
    if (!detail) return "";
    return `输入 ${money(detail.inputCost)} + 输出 ${money(detail.outputCost)} + 缓存 ${money(detail.cachedInputCost)} = 原始 ${money(detail.originalCost)} × ${Number(detail.multiplier).toFixed(2)}x`;
  };
  const modeText = { economy: "经济", balanced: "平衡", speed: "速度" };
  const costSourceText = { upstream_header: "中转站响应头", upstream_body: "中转站用量", proxy_aggregate: "代理请求合计", balance_delta: "余额扣款归因", estimated: "本地估算", unavailable: "中转站未提供费用" };
  const sourceText = { codex_rollout: "Codex rollout", proxy: "本地代理", combined: "rollout + 代理" };

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || payload.error || `请求失败 ${response.status}`);
    return payload;
  }

  function latestRequest() { return state?.telemetry?.requests?.[0] || null; }
  function activeRecord() { return state?.currentTurn || latestRequest(); }
  function provider(id) { return state?.providers?.find((item) => String(item.id) === String(id)); }

  function renderSystemState() {
    const banner = $("#system-state");
    const runtime = state?.runtime || {};
    const config = state?.config || {};
    const auth = runtime.auth || {};
    const hasRequests = Boolean(state?.telemetry?.totals?.requests || state?.currentTurn);
    let kind = "warning";
    let title = "等待第一个 Codex 请求";
    let detail = "rollout 采集器已启动，收到请求后会显示精确指标。";
    if (!runtime.running) {
      kind = "error"; title = "本地监控服务不可用"; detail = "面板已加载，但后台服务没有运行。";
    } else if (!runtime.rollout?.running) {
      kind = "error"; title = "Codex 会话采集器未运行"; detail = runtime.rollout?.lastError || "无法读取 Codex rollout 数据。";
    } else if (config.relayAdapter === "generic") {
      kind = hasRequests ? "good" : "warning";
      title = `${config.relayName || "通用中转站"}本地监控已启用`;
      detail = runtime.proxyObserved ? "请求、Token、缓存、费用和延迟均由本地代理观测。" : "rollout 指标已启用；启用本地代理后可获得完整费用和首字延迟。";
    } else if (!config.credentialsConfigured) {
      title = "Codex 指标可用，尚未登录 AIHub";
      detail = "请运行插件 scripts/set-credential.ps1，使用 AIHub 邮箱和密码登录。";
    } else if (!auth.authenticated) {
      kind = "error";
      title = "AIHub 登录未通过";
      detail = auth.lastError || "凭据已保存，但 AIHub 尚未接受当前登录。";
    } else if (runtime.lastError?.length) {
      title = "部分 AIHub 数据不可用";
      detail = runtime.lastError.map((item) => item.source).join("、") + " 刷新失败，已保留可用数据。";
    } else if (hasRequests && !runtime.proxyObserved) {
      title = "Codex 当前绕过本地代理";
      detail = "本轮指标可读取；费用关联和同次重试前切组尚未启用。";
    } else if (runtime.proxyObserved) {
      kind = "good"; title = "完整监控已启用"; detail = "rollout 与本地代理均已观测到请求。";
    }
    banner.className = `state-banner state-${kind}`;
    $("#state-title").textContent = title;
    $("#state-detail").textContent = detail;
    $("#source-badge").textContent = runtime.telemetryMode === "rollout+proxy" ? "ROLLOUT + PROXY" : "ROLLOUT";
  }

  function renderHeader() {
    const config = state.config || {};
    const latest = activeRecord();
    const active = provider(latest?.groupId ?? state.currentGroupId);
    $("#service-dot").className = `status-dot ${state.runtime?.running ? "ok" : "bad"}`;
    $("#service-label").textContent = state.runtime?.running ? "监控运行中" : "远程监控";
    $("#metric-model").textContent = latest?.model || "等待请求";
    const effort = latest?.reasoningEffort;
    $("#metric-reasoning").textContent = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "--";
    $("#metric-tokens").textContent = latest ? `↓ ${number(uncachedInput(latest))}  ↑ ${number(latest.outputTokens)}` : "--";
    $("#metric-total").textContent = latest ? `缓存 ${number(latest.cachedTokens)} · 总计 ${number(latest.totalTokens)}` : "缓存 -- · 总计 --";
    $("#metric-cost").textContent = money(latest?.cost);
    $("#metric-cost").title = costDetail(latest);
    $("#metric-cost-source").textContent = costDetail(latest) || costSourceText[latest?.costSource] || (latest?.source === "codex_rollout" ? "等待中转站费用" : "来源 --");
    const runningMs = latest?.state === "running" ? Date.now() - Date.parse(latest.startedAt) : latest?.totalMs;
    $("#metric-ttft").textContent = `首字 ${time(latest?.firstByteMs)}`;
    $("#metric-total-ms").textContent = `${latest?.state === "running" ? "进行中" : "总耗时"} ${time(runningMs)}`;
    $("#metric-group").textContent = active?.name || latest?.groupName || config.relayName || "--";
    const multiplier = active?.multiplier ?? latest?.multiplier ?? config.relayMultiplier;
    $("#metric-multiplier").textContent = `倍率 ${Number.isFinite(Number(multiplier)) ? `${Number(multiplier).toFixed(2)}x` : "--"}`;
    $("#metric-balance").textContent = state.balance ? `${state.balance.currency === "USD" ? "$" : `${esc(state.balance.currency)} `}${number(state.balance.amount, 6)}` : "--";
    const balanceAge = state.balance?.fetchedAt ? Date.now() - Date.parse(state.balance.fetchedAt) : Infinity;
    $("#metric-balance-source").textContent = state.balance ? (balanceAge > 180000 ? "余额数据已过期" : "账户余额") : (state.runtime?.auth?.authenticated ? "余额接口未返回数据" : "未认证");
    $("#proxy-address").textContent = `代理 ${state.runtime?.proxyUrl || "--"}`;
    $("#last-refresh").textContent = state.runtime?.lastRefreshAt ? `更新 ${new Date(state.runtime.lastRefreshAt).toLocaleTimeString()}` : "尚未刷新";
    $("#route-mode").textContent = modeText[config.mode] || config.mode || "平衡";
    document.querySelectorAll("[data-mode]").forEach((button) => { button.hidden = config.relayAdapter === "generic"; });
    $("#runtime-version").textContent = `${config.relayName || "Relay"} Codex Monitor ${state.runtime?.version || ""}`.trim();
    document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === config.mode));
    const errors = state.runtime?.lastError;
    $("#footer-error").textContent = errors?.length ? errors.map((error) => error.message).join(" · ") : "";
  }

  function renderOverview() {
    const latest = activeRecord();
    const totals = state.telemetry?.totals || {};
    const route = state.routeDecision;
    const active = provider(state.currentGroupId);
    $("#route-name").textContent = route?.selected?.name || active?.name || state.config?.relayName || "等待供应商数据";
    $("#route-reason").textContent = route?.reason || (state.config?.relayAdapter === "generic" ? "通用适配器提供本地指标与费用估算；高级路由需专用适配器。" : "刷新后显示经济、速度和倍率权衡。");
    $("#route-candidates").textContent = `候选 ${route?.candidates?.filter((item) => item.eligible).length ?? "--"}`;
    $("#route-confidence").textContent = route?.selected ? `置信度 ${percent(route.selected.confidence)}` : "置信度 --";
    $("#summary-requests").textContent = latest ? (latest.state === "running" ? "进行中" : "1") : "--";
    $("#summary-total-requests").textContent = number(totals.requests);
    $("#summary-tokens").textContent = latest ? number(latest.totalTokens) : "--";
    $("#summary-total-tokens").textContent = number(totals.totalTokens);
    $("#summary-cost").textContent = money(latest?.cost);
    $("#summary-total-cost").textContent = money(totals.cost);
    $("#recent-request").className = latest ? "request-line" : "request-line empty-state";
    $("#recent-request").innerHTML = latest
      ? `<strong>${esc(latest.model)}</strong> <span class="muted">${esc(latest.reasoningEffort)} · 非缓存输入 ${number(uncachedInput(latest))} · 缓存 ${number(latest.cachedTokens)} · 输出 ${number(latest.outputTokens)} · ${money(latest.cost)} · 首字 ${time(latest.firstByteMs)} · ${latest.state === "running" ? "进行中" : `总耗时 ${time(latest.totalMs)}`} · ${esc(sourceText[latest.source] || latest.source)}</span>`
      : "等待第一个 Codex 请求。";
  }

  function renderProviders() {
    const providers = [...(state.providers || [])].sort((a, b) => (a.multiplier ?? Infinity) - (b.multiplier ?? Infinity) || String(a.id).localeCompare(String(b.id)));
    $("#provider-count").textContent = `${providers.length} 个分组`;
    $("#provider-rows").innerHTML = providers.length ? providers.map((item) => {
      const active = String(item.id) === String(state.currentGroupId);
      const healthClass = { available: "good", error: "bad", cooldown: "warn", unverified: "" }[item.healthState] || "";
      const healthText = item.healthLabel || "未检测";
      const modelCheckText = { supported: "当前模型已验证", unsupported: "不支持当前模型", unverified: "未检测", unknown: "接口未提供模型列表", warning: "模型检测警告", available: "已提供模型列表" };
      const modelSupportText = modelCheckText[item.modelSupport] || modelCheckText[item.modelCheck] || "未检测";
      const models = item.models?.length ? item.models.slice(0, 3).map((model) => `<span class="model-tag">${esc(model)}</span>`).join("") : `<span class="muted">${esc(item.modelSupport === "unsupported" ? "当前模型不在列表" : "接口未提供模型列表")}</span>`;
      const metricText = (value, source) => present(value) ? percent(value) : source === "aihub_unavailable" ? "接口未提供" : item.localSampleCount ? "无有效样本" : "未采样";
      const sourceText = { aihub: "AIHub 接口", local_requests: "本机请求", local_unavailable: "本机无有效样本", aihub_unavailable: "接口未提供" };
      const canSwitch = state.runtime?.auth?.authenticated && (state.config?.managedKeyIds || []).length > 0 && item.switchEligible !== false && !active;
      const routeReason = item.excludedReasons?.length ? `自动路由：${item.excludedReasons.join(", ")}` : "自动路由可用";
      const speed = item.speedValueMs ?? item.ttftMs;
      const speedSource = item.speedSource === "local_requests" ? `本机 ${item.localSampleCount || 0} 个请求` : item.speedSource === "aihub_public_ttft" ? "AIHub 公共 TTFT" : "未采样";
      const trendValues = (item.trend || []).map((point) => Number(point.ttftMs)).filter(Number.isFinite);
      const trendMax = trendValues.length ? Math.max(...trendValues) : 0;
      const trend = trendValues.length ? `<span class="sparkline" aria-label="最近请求速度趋势">${trendValues.slice(-12).map((value) => `<i style="height:${Math.max(12, Math.round((value / trendMax) * 100))}%"></i>`).join("")}</span>` : "";
      return `<tr class="${active ? "active-row" : ""}">
        <td class="provider-name"><strong>${esc(item.name)}</strong><span class="code">${esc(item.code || `#${item.id}`)}</span></td>
        <td><strong>${item.multiplier === null || item.multiplier === undefined ? "--" : `${Number(item.multiplier).toFixed(2)}x`}</strong></td>
        <td><span class="badge ${healthClass}">${esc(healthText)}</span><div class="model-tags">${models}</div><small>${esc(item.healthDetail || "接口未提供健康状态")} · ${esc(item.freshness || "未采样")}</small></td>
        <td><strong>${time(speed)}</strong><small>${esc(speedSource)}${item.outputTokensPerSecond ? ` · 输出 ${number(item.outputTokensPerSecond, 1)} t/s` : ""}</small>${trend}</td>
        <td title="${esc(sourceText[item.cacheHitRateSource] || "未采样")}"><strong>${metricText(item.cacheHitRate, item.cacheHitRateSource)}</strong><small>${esc(sourceText[item.cacheHitRateSource] || "未采样")}</small></td>
        <td title="${esc(sourceText[item.successRateSource] || "未采样")}"><strong>${metricText(item.successRate, item.successRateSource)}</strong><small>${esc(sourceText[item.successRateSource] || "未采样")}</small></td>
        <td><span class="badge ${item.modelSupport === "unsupported" ? "bad" : item.modelSupport === "supported" ? "good" : "warn"}">${esc(modelSupportText)}</span><small>${esc(item.modelCheckSource === "aihub" ? "AIHub 模型列表" : item.modelCheckSource === "local_requests" ? "本机请求" : "未观测")}</small></td>
        <td><button class="switch-button" data-switch="${esc(item.id)}" ${canSwitch ? "" : "disabled"}>${active ? "当前使用" : "使用此分组"}</button><small>${esc(active ? "当前请求将使用此组" : canSwitch ? routeReason : "请先认证并配置管理 Key ID")}</small></td>
      </tr>`;
    }).join("") : `<tr><td colspan="8" class="empty-state">等待供应商数据</td></tr>`;
    document.querySelectorAll("[data-switch]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { const payload = await request("/api/actions/switch", { method: "POST", body: JSON.stringify({ groupId: Number(button.dataset.switch) }) }); state = payload.state; render(); showToast("分组已切换"); }
      catch (error) { showToast(error.message); button.disabled = false; }
    }));
  }

  function renderRequests() {
    const requests = state.telemetry?.requests || [];
    $("#request-rows").innerHTML = requests.length ? requests.map((item) => {
      const statusClass = Number(item.status) >= 400 ? "bad" : "good";
      return `<tr><td>${item.startedAt ? new Date(item.startedAt).toLocaleTimeString() : "--"}</td><td><strong>${esc(item.model)}</strong></td><td>${esc(item.reasoningEffort)}</td><td>${number(uncachedInput(item))} / ${number(item.outputTokens)}<small>缓存 ${number(item.cachedTokens)} · 总计 ${number(item.totalTokens)}</small></td><td title="${esc(costDetail(item))}">${money(item.cost)}<small>${esc(costDetail(item) || costSourceText[item.costSource] || "")}</small></td><td><strong>${time(item.firstByteMs)}</strong><small>${time(item.totalMs)}</small></td><td>${esc(item.groupName || item.groupId || "--")}<small>${item.multiplier === null || item.multiplier === undefined ? "" : `${Number(item.multiplier).toFixed(2)}x`}</small></td><td><span class="badge ${statusClass}">${item.outcome === "error" ? "错误" : esc(item.status)}</span><small>${esc(sourceText[item.source] || item.source)}${item.failovers?.length ? ` · ${item.failovers.length} 次切换` : ""}</small></td></tr>`;
    }).join("") : `<tr><td colspan="8" class="empty-state">还没有请求</td></tr>`;
  }

  function renderSettings() {
    const config = state.config || {};
    const auth = state.runtime?.auth || {};
    $("#managed-key-ids").value = (config.managedKeyIds || []).join(", ");
    $("#blacklisted-group-ids").value = (config.blacklistedGroupIds || []).join(", ");
    $("#maximum-multiplier").value = config.maximumMultiplier ?? "";
    $("#minimum-confidence").value = config.minimumConfidence ?? "";
    $("#group-stickiness").value = config.groupStickiness ?? "";
    $("#poll-interval").value = config.pollIntervalSeconds ?? "";
    $("#model-pricing").value = JSON.stringify(config.modelPricing || {});
    $("#model-aliases").value = JSON.stringify(config.modelAliases || {});
    $("#routing-enabled").checked = config.routingEnabled !== false;
    $("#failover-enabled").checked = config.failoverEnabled !== false;
    const credentialSource = config.credentialSource?.startsWith("windows_dpapi") ? "Windows DPAPI" : config.credentialSource?.startsWith("environment") ? "环境变量" : "--";
    $("#credential-state").textContent = config.relayAdapter === "generic" ? "通用适配器不读取账户凭据" : auth.authenticated
      ? `AIHub 已认证 · ${credentialSource}`
      : config.credentialsConfigured ? `登录未通过 · ${credentialSource}` : "尚未登录 AIHub";
    $("#credential-help").textContent = config.relayAdapter === "generic" ? "填写中转站地址、模型价格、倍率和可选模型别名即可。" : auth.authenticated
      ? `登录方式：${auth.method || "未知"}${auth.expiresAt ? ` · Token 到期 ${new Date(auth.expiresAt).toLocaleString()}` : ""}`
      : "在 PowerShell 运行插件 scripts/set-credential.ps1，输入 AIHub 邮箱和密码。";
  }

  function render() {
    if (!state) return;
    renderSystemState(); renderHeader(); renderOverview(); renderProviders(); renderRequests();
    if (!$("#settings-form").contains(document.activeElement)) renderSettings();
  }

  async function refresh() {
    try { state = await request("/api/actions/refresh", { method: "POST", body: "{}" }); render(); }
    catch (error) { showToast(error.message); }
  }

  function connectEvents() {
    const source = new EventSource("/api/events");
    source.addEventListener("state", (event) => { try { state = JSON.parse(event.data); render(); } catch { /* Keep the last valid state. */ } });
    source.onerror = () => { source.close(); setTimeout(connectEvents, 5000); };
  }

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    currentView = button.dataset.view;
    document.querySelectorAll(".view-tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
    document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `view-${currentView}`));
  }));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", async () => {
    try { state = await request("/api/actions/route", { method: "POST", body: JSON.stringify({ mode: button.dataset.mode }) }); render(); showToast(`已切换到${modeText[button.dataset.mode]}模式`); }
    catch (error) { showToast(error.message); }
  }));
  $("#refresh-button").addEventListener("click", refresh);
  $("#open-requests").addEventListener("click", () => document.querySelector('[data-view="requests"]').click());
  $("#layout-button").addEventListener("click", () => { const next = document.body.dataset.layout === "vertical" ? "horizontal" : "vertical"; document.body.dataset.layout = next; localStorage.setItem("aihub-monitor-layout", next); });
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#settings-message");
    try {
      const pricing = JSON.parse($("#model-pricing").value || "{}");
      const aliases = JSON.parse($("#model-aliases").value || "{}");
      state = await request("/api/config", { method: "PATCH", body: JSON.stringify({
        relayAdapter: $("#relay-adapter").value,
        relayName: $("#relay-name").value,
        relayBaseUrl: $("#relay-base-url").value,
        relayMultiplier: Number($("#relay-multiplier").value),
        relayCurrency: $("#relay-currency").value,
        modelAliases: aliases,
        managedKeyIds: $("#managed-key-ids").value.split(",").map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0),
        blacklistedGroupIds: $("#blacklisted-group-ids").value.split(",").map((value) => value.trim()).filter(Boolean),
        routingEnabled: $("#routing-enabled").checked,
        failoverEnabled: $("#failover-enabled").checked,
        maximumMultiplier: Number($("#maximum-multiplier").value),
        minimumConfidence: Number($("#minimum-confidence").value),
        groupStickiness: Number($("#group-stickiness").value),
        pollIntervalSeconds: Number($("#poll-interval").value),
        modelPricing: pricing,
      }) });
      message.textContent = "已保存"; render(); setTimeout(() => { message.textContent = ""; }, 1800);
    } catch (error) { message.textContent = error.message; }
  });

  request("/api/state").then((payload) => { state = payload; render(); connectEvents(); }).catch((error) => {
    $("#system-state").className = "state-banner state-error";
    $("#state-title").textContent = "无法连接本地监控服务";
    $("#state-detail").textContent = error.message;
    $("#source-badge").textContent = "OFFLINE";
    showToast(error.message);
  });
  setInterval(() => { if (state?.currentTurn) renderHeader(); }, 1000);
})();
    $("#relay-adapter").value = config.relayAdapter || "aihub";
    $("#relay-name").value = config.relayName || "";
    $("#relay-base-url").value = config.relayBaseUrl || config.aihubBaseUrl || "";
    $("#relay-multiplier").value = config.relayMultiplier ?? 1;
    $("#relay-currency").value = config.relayCurrency || "USD";
