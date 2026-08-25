#!/usr/bin/env node

const port = Number(process.argv[2] || 9347);

class Session {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  command(method, params = {}) {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
const targets = await response.json();
const results = [];
for (const target of targets.filter((item) => item.type === "page" && item.webSocketDebuggerUrl)) {
  const session = new Session(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    const result = await session.evaluate(`(() => {
      const root = document.getElementById("aihub-statusline");
      const row = document.getElementById("aihub-statusline-row");
      const drawer = document.getElementById("aihub-monitor-drawer");
      if (!root || !row || !drawer) return {
        installed: false,
        url: location.href,
        proseMirror: document.querySelectorAll(".ProseMirror").length,
        contentEditable: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(-5).map((node) => ({ tag: node.tagName, role: node.getAttribute("role"), classes: node.className })),
        textareas: Array.from(document.querySelectorAll("textarea")).slice(-5).map((node) => ({ placeholder: node.getAttribute("placeholder"), classes: node.className })),
      };
      const wasOpen = !drawer.hidden;
      if (!wasOpen) row.click();
      const report = {
        installed: true,
        visible: getComputedStyle(root).display !== "none" && row.getBoundingClientRect().height > 0,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        position: root.classList.contains("aihub-fixed") ? "fixed-fallback" : "above-composer",
        drawerOpen: !drawer.hidden,
        views: Array.from(root.querySelectorAll("[data-aihub-view]")).map((node) => node.textContent.trim()),
        modes: Array.from(root.querySelectorAll("[data-aihub-mode]")).map((node) => node.textContent.trim()),
        providerRows: root.querySelectorAll("#aihub-provider-rows tr").length,
        hasBalance: Boolean(document.getElementById("aihub-balance-badge")),
        hasSettings: Boolean(document.getElementById("aihub-save-settings")),
      };
      if (!wasOpen) row.click();
      return report;
    })()`);
    if (result) results.push(result);
  } finally {
    session.close();
  }
}

console.log(JSON.stringify({ ok: results.some((item) => item.visible && item.drawerOpen), pages: results }, null, 2));
if (!results.some((item) => item.visible && item.drawerOpen)) process.exitCode = 1;
