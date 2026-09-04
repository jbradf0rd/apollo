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
import { loadConfig, saveConfig } from "./storage.js";

const WS_URL = "ws://127.0.0.1:8765/";
const KEEPALIVE_MS = 20000;
const MAX_RECONNECT_MS = 30000;

let ws = null;
let keepAliveTimer = null;
let reconnectDelay = 1000;
let stopped = false;
let chatSeq = 0;
const chatPending = new Map(); // chatSeq -> { resolve, onDelta }

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
    else if (msg.t === "chat_delta" || msg.t === "chat_res") settleChat(msg);
    else if (msg.t === "provider") applyHermesProvider(msg);
  };

  socket.onclose = () => {
    stopKeepAlive();
    setBadge(false, 0);
    // Fail any in-flight Hermes chats — the relay is gone.
    for (const [, p] of chatPending) p.resolve({ ok: false, error: "Hermes bridge disconnected." });
    chatPending.clear();
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
  setBadge(true, tools.length);
}

// Visible bridge state on the toolbar icon: green ✓ while the Hermes relay is
// connected, red ✗ when the connection drops. This is the fork's on-screen
// "the bridge is alive" indicator.
function setBadge(connected, toolCount) {
  try {
    if (connected) {
      chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setTitle({ title: `Apollo — Hermes bridge connected (${toolCount} browser tools)` });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      chrome.action.setBadgeText({ text: "✗" });
      chrome.action.setTitle({ title: "Apollo — Hermes bridge disconnected" });
    }
  } catch {
    /* badge is cosmetic — never break the relay for it */
  }
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

// ---------------------------------------------------------------------------
// Chat channel — the side panel talks to Hermes through the relay
// ---------------------------------------------------------------------------

export function isRelayOpen() {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

// True while the relay is up OR a reconnect is in flight — used for UI state
// so a freshly-restarted worker doesn't look "unconfigured" for the second it
// takes the socket to come up. Actual chat/tool calls still gate on OPEN.
export function isRelayConnecting() {
  return !!(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING));
}

function settleChat(msg) {
  if (msg.t === "chat_delta") {
    const p = chatPending.get(msg.id);
    if (p && p.onDelta) p.onDelta(msg.text || "");
    return;
  }
  const p = chatPending.get(msg.id);
  if (!p) return;
  chatPending.delete(msg.id);
  p.resolve(msg);
}

// Send one user message to the Hermes chat session; resolves with the relay's
// { ok, text | error }. Streams text chunks via onDelta as they arrive.
export function sendRelayChat(text, { onDelta, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!isRelayOpen()) {
      reject(new Error("Hermes bridge offline."));
      return;
    }
    const id = ++chatSeq;
    const onAbort = () => {
      chatPending.delete(id);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    chatPending.set(id, {
      onDelta,
      resolve: (msg) => {
        signal?.removeEventListener("abort", onAbort);
        if (msg.ok === false) resolve({ ok: false, error: msg.error || "hermes chat failed" });
        else resolve({ ok: true, text: (msg.text || "").trim() });
      },
    });
    send({ t: "chat", id, text });
  });
}

// Tell the relay to start a fresh Hermes conversation (New Chat button).
export function sendRelayNewChat() {
  if (!isRelayOpen()) return;
  const id = ++chatSeq;
  send({ t: "chat_new", id });
}

// Tell the relay to kill the running hermes process (Stop button).
export function sendRelayChatAbort() {
  if (!isRelayOpen()) return;
  const id = ++chatSeq;
  send({ t: "chat_abort", id });
}

// ---------------------------------------------------------------------------
// Provider port — the relay sends Hermes's active model, the extension stores
// it as a "hermes" provider so the lean panel agent uses the same model.
// ---------------------------------------------------------------------------

async function applyHermesProvider(msg) {
  try {
    const config = await loadConfig();
    const id = "hermes";
    const baseUrl = msg.baseUrl || "";
    const apiKey = msg.apiKey || "";
    const model = msg.model || "";
    const type = msg.type === "anthropic" ? "anthropic" : "openai";
    const reachable = msg.reachable !== false; // default true if the relay omitted it

    // If Hermes's active model has no portable key (e.g. claude via OAuth), we
    // CANNOT call it directly from the browser. Record why so the panel can say
    // so, and DON'T switch the active provider away from whatever still works.
    if (!reachable) {
      config.hermesPortNote = msg.reason || ("Hermes's active model '" + model + "' has no browser-usable API key.");
      config.hermesActiveModel = model;
      config.hermesActiveProvider = msg.provider || "";
      await saveConfig(config);
      console.warn("[apollo-relay] active Hermes model not directly reachable:", msg.provider, model, "-", msg.reason);
      return;
    }

    const cur = (config.providers || []).find((p) => p.id === id);
    // Dedupe: skip the write when nothing changed. This also breaks the
    // save → storage.onChanged → register → provider loop.
    if (
      cur &&
      cur.baseUrl === baseUrl &&
      cur.apiKey === apiKey &&
      cur.type === type &&
      config.activeProviderId === id &&
      config.activeModel === model &&
      !config.hermesPortNote
    ) {
      return;
    }
    const providers = (config.providers || []).filter((p) => p.id !== id);
    providers.push({
      id,
      name: "Hermes (" + (msg.provider || "model") + ")",
      type,
      baseUrl,
      apiKey,
    });
    config.providers = providers;
    config.activeProviderId = id;
    config.activeModel = model;
    delete config.hermesPortNote; // clear any stale "unreachable" note
    config.hermesActiveModel = model;
    config.hermesActiveProvider = msg.provider || "";
    await saveConfig(config);
    console.log("[apollo-relay] ported Hermes model:", msg.provider, model, "(" + type + ")");
  } catch (e) {
    console.warn("[apollo-relay] provider apply failed:", e.message || e);
  }
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
