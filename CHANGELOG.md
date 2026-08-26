# Changelog

## 0.3.2 - 2026-08-26

- Log monitor, CDP, and status-line health transitions so a missing theme debug endpoint is distinguishable from a monitor failure after boot.
- Keep waiting for the theme CDP endpoint and recover the status-line injector automatically when it becomes available.

## 0.3.1 - 2026-08-26

- Add a self-contained Windows installer that can create the personal
  marketplace entry without Python or a separate Plugin Creator checkout.
- Add verified Release ZIP packaging and tag-driven GitHub Release automation.

## 0.3.0 - 2026-08-25

- Add generic OpenAI-compatible relay configuration, model aliases, local
  pricing tables, multipliers, currencies, and cost estimation.
- Keep AIHub-specific balance, group, health, Key, routing, and failover data.
- Launch the monitor and status line through a hidden Windows startup entry.
