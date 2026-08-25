---
name: aihub-monitor
description: Monitor Codex model requests through AIHub, inspect live model/reasoning/token/cost/latency metrics, view balance and provider health, choose economy/balanced/speed routing, or switch AIHub Key groups.
---

# AIHub Codex Monitor

Use the plugin MCP tools for AIHub monitoring and routing requests.

## Workflow

1. Call `aihub_monitor_status` before answering status, balance, current request, provider, or active-group questions.
2. Call `aihub_monitor_refresh` when the user asks for current provider data or an immediate route decision.
3. Call `aihub_monitor_set_mode` for economy, balanced, or speed preference changes.
4. Call `aihub_monitor_switch_group` only when the user explicitly requests a specific group.
5. Call `aihub_monitor_statusline` when the user wants persistent live status in the Codex desktop UI. It starts a CDP injector only when the current Codex process already exposes the local debug port; it never restarts Codex. If `requiresCodexRestart` is true, give the returned local restart command and explain that the current task must be resumed after Codex restarts.
6. Call `aihub_monitor_dashboard` only when the user explicitly wants the full dashboard. Open its returned loopback URL with the built-in Codex browser-panel tool, using `bottom` for a horizontal panel or `right` for a vertical panel.
7. Call `aihub_monitor_configure` only for non-secret settings. Never request or pass an AIHub email, password, cookie, or access token in chat or tool arguments. Authentication is performed locally by `scripts/set-credential.ps1`, which stores a DPAPI-protected login payload; environment variables remain supported for unattended setups.

## Safety

- Never expose email/password pairs, Authorization headers, API keys, cookies, access tokens, or refresh tokens.
- Model, reasoning, Token, and Codex-perceived latency telemetry comes from local rollout files even when the proxy is disabled. Explain that request cost/group correlation and retry-time switching require traffic through the loopback proxy.
- The status line is a local CDP DOM injection above the Codex composer, not an official plugin manifest UI slot. State this distinction when installation or compatibility matters.
- The proxy never replays model requests. On eligible failures it switches the AIHub group for Codex's next native retry.
- On Windows, direct the user to the local `scripts/set-credential.ps1` flow; never collect login credentials in chat. The monitor logs in through `/api/v1/auth/login`, refreshes sessions through `/api/v1/auth/refresh`, and reports authentication as successful only after AIHub accepts the session.
