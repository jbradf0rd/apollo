// Apollo <-> Hermes relay client (background service worker side).
//
// Keeps an outbound WebSocket to the local Apollo relay daemon
// (bridge/relay.mjs) and executes browser tool calls that arrive over it —
// the same executeTool surface the built-in agent loop uses, driven remotely
// by Hermes via MCP. Chrome extensions cannot listen on sockets, so this
// module connects OUT and the relay multiplexes Hermes's MCP processes onto
// this one connection.
//
// Wire protocol (JSON text frames): see bridge/relay.mjs.
//
// Safety: mutating tools are executed only when the config flag
// `hermesRelay.allowMutating` is true (default true — Hermes-driven acting is
// the point of the bridge). Set it false for a read-only relay. The full
// permission/approval layer (per-site rules, sensitive-site confirmation) is
// ported onto this path separately; until then every mutating execution is
// logged loudly to the service worker console.

import { TOOL_DEFS, executeTool } from "./tools.js";
import { MUTATING_TOOLS } from "./permissions.js";
import { loadConfig } from "./storage.js";

const WS_URL = "ws://127.0.0.1:8765/";
const KEEPALIVE_MS = 20000;
const MAX_RECONNECT_MS = 30000;

let ws = null;
let keepAliveTimer = null;
let reconnectDelay = 1000;
let stopped = false;

// The remote agent's "focused tab": starts at the active tab of the
// last-focused window; open_tab / switch_tab move it (same contract the
// built-in agent loop's ctx has).
const ctx = {
  _tabId: null,
  async getTabId() {
    if (this._tabId != null) {
      try {
        await chrome.tabs.get(this._tabId);
        return this._tabId;
      } catch {
        this._tabId = null; // tab closed — fall through to the active tab
      }
    }
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ active: true }))[0];
    this._tabId = tab ? tab.id : null;
    return this._tabId;
  },
  setTabId(id) {
    this._tabId = id;
  },
};

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export function startRelay() {
  stopped = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[apollo-relay] cannot open socket:", e.message || e);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = async () => {
    reconnectDelay = 1000;
    console.log("[apollo-relay] connected to", WS_URL);
    startKeepAlive();
    await register();
  };

  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === "ping") send({ t: "pong" });
    else if (msg.t === "call") handleCall(msg);
  };

  socket.onclose = () => {
    stopKeepAlive();
    ws = null;
    if (!stopped) scheduleReconnect();
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };
}

export function stopRelay() {
  stopped = true;
  stopKeepAlive();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
}

function scheduleReconnect() {
  if (stopped) return;
  setTimeout(startRelay, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
}

// MV3 kills an idle service worker after ~30s; an open WebSocket doesn't hold
// it. Ping a chrome API every 20s while the relay is connected (same pattern
// the built-in agent loop uses during runs).
function startKeepAlive() {
  if (keepAliveTimer != null) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_MS);
}
function stopKeepAlive() {
  if (keepAliveTimer != null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Registration + tool dispatch
// ---------------------------------------------------------------------------

async function register() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let config = {};
  try {
    config = (await loadConfig()) || {};
  } catch {
    /* defaults below */
  }
  const settings = config.settings || {};
  const tools = TOOL_DEFS.filter((t) => {
    if (t.name === "finish") return false; // Hermes owns task completion
    if (t.visionOnly && !settings.enableVision) return false;
    if (t.jsOnly && !settings.enableJsTool) return false;
    if (t.cdpOnly && !settings.enableCdp) return false;
    return true;
  }).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters, // already JSON Schema
  }));
  send({
    t: "reg",
    name: "apollo-extension",
    tools,
    mutating: [...MUTATING_TOOLS],
  });
  console.log(`[apollo-relay] registered ${tools.length} tools with the relay`);
}

async function handleCall(msg) {
  const { id, name, args } = msg;
  if (MUTATING_TOOLS.has(name) && !(await allowMutating())) {
    console.warn(`[apollo-relay] BLOCKED mutating tool "${name}" (allowMutating=false)`);
    send({ t: "res", id, ok: false, error: `"${name}" modifies the page and the relay is in read-only mode.` });
    return;
  }
  if (MUTATING_TOOLS.has(name)) {
    console.warn(`[apollo-relay] executing mutating tool "${name}" with args:`, JSON.stringify(args || {}).slice(0, 300));
  }
  try {
    const result = await executeTool(name, args || {}, ctx);
    send({ t: "res", id, ok: result.ok !== false, result });
  } catch (e) {
    send({ t: "res", id, ok: false, error: String((e && e.message) || e) });
  }
}

async function allowMutating() {
  try {
    const config = (await loadConfig()) || {};
    return config.hermesRelay?.allowMutating !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// If relay settings change (vision/js/devtools toggles), the tool list Hermes
// sees changes too — re-register so tools/list stays truthful.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const key of Object.keys(changes)) {
    if (key.includes("config")) {
      register();
      return;
    }
  }
});
