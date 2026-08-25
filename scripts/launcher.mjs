#!/usr/bin/env node
import { access, cp, mkdir, readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dataRoot() {
  if (process.env.AIHUB_MONITOR_DATA_DIR) return path.resolve(process.env.AIHUB_MONITOR_DATA_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "AIHubCodexMonitor");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AIHubCodexMonitor");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aihub-codex-monitor");
}

async function manifestVersion() {
  try {
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, ".codex-plugin", "plugin.json"), "utf8"));
    return String(manifest.version || "development").replace(/[^a-zA-Z0-9._+-]/g, "-");
  } catch {
    return "development";
  }
}

async function prepareRuntime() {
  const version = await manifestVersion();
  const versionsDir = path.join(dataRoot(), "versions");
  const target = path.join(versionsDir, version);
  try {
    await access(path.join(target, "server.mjs"));
    return target;
  } catch { /* Install this immutable runtime version below. */ }

  await mkdir(versionsDir, { recursive: true });
  const staging = path.join(versionsDir, `.${version}.${process.pid}.${Date.now()}.staging`);
  await mkdir(staging, { recursive: false });
  for (const entry of ["server.mjs", "package.json", "src", "assets", "statusline"]) {
    await cp(path.join(sourceRoot, entry), path.join(staging, entry), { recursive: true, errorOnExist: true });
  }
  try {
    await rename(staging, target);
  } catch (error) {
    try {
      await access(path.join(target, "server.mjs"));
    } catch {
      throw error;
    }
  }
  return target;
}

const runtimeRoot = await prepareRuntime();
process.chdir(runtimeRoot);
await import(pathToFileURL(path.join(runtimeRoot, "server.mjs")).href);
