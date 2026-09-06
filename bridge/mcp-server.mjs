// Apollo MCP server — the process Hermes spawns (stdio transport).
//
// Hermes runs this via `hermes mcp add` as a stdio command. It is a thin
// Model Context Protocol server that proxies every tool call to the Apollo
// relay (ws://127.0.0.1:8765 by default), which forwards to the Chrome
// extension. See relay.mjs for the wire protocol.
//
// NEVER write to stdout except JSON-RPC responses — Hermes parses stdout as
// the MCP stream. All logging goes to stderr.
//
// Run (standalone debug):  node bridge/mcp-server.mjs
// Env:  APOLLO_WS_URL  default ws://127.0.0.1:8765

import readline from "node:readline";

const WS_URL = process.env.APOLLO_WS_URL || "ws://127.0.0.1:8765";
const PROTOCOL_VERSION = "2025-06-18";
const TOOL_TIMEOUT_MS = 180_000;

const log = (...m) => console.error("[apollo-mcp]", ...m);

// --- JSON-RPC over stdio ---------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let idCounter = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// --- WS control connection to the relay ------------------------------------

let ws = null;
let wsReady = false;
let connectFailures = 0; // consecutive connect attempts that never reached OPEN
let clientInitialized = false; // Hermes finished the MCP handshake
let loggedEnv = false; // one-shot env dump on the first socket failure
const wsQueue = []; // JSON messages queued until the socket is up

function connectWs() {
  log(`connecting to relay at ${WS_URL}...`);
  let sock;
  try {
    sock = new WebSocket(WS_URL);
  } catch (e) {
    log("WebSocket construction failed:", e.message);
    setTimeout(connectWs, 2000);
    return;
  }
  ws = sock;
  // A stalled handshake (relay restarted mid-connect) must not hang forever:
  // it leaves tool calls queued and they die with "relay timed out". Force a
  // retry if the socket isn't open shortly.
  const stall = setTimeout(() => {
    if (sock.readyState !== WebSocket.OPEN) {
      log("relay handshake stalled — forcing retry");
      try { sock.close(); } catch {}
    }
  }, 5000);
  sock.onopen = () => {
    clearTimeout(stall);
    connectFailures = 0;
    log("relay connected");
    wsReady = true;
    for (const m of wsQueue.splice(0)) sock.send(JSON.stringify(m));
    // Every (re)connect should refresh Hermes's tool list — it may have
    // missed ext_state broadcasts while we were disconnected, leaving a
    // stale list after any relay bounce.
    if (clientInitialized) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };
  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === "res") settle(msg.id, msg);
    else if (msg.t === "pong") {/* keepalive reply */}
    else if (msg.t === "ext_state") {
      log(`extension ${msg.connected ? "connected" : "disconnected"} (${msg.tools} tools)`);
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    else log("unexpected relay message:", msg.t);
  };
  sock.onclose = () => {
    clearTimeout(stall);
    if (ws === sock) ws = null;
    log("relay connection lost");
    wsReady = false;
    // Fail any in-flight calls so Hermes doesn't hang forever.
    failAll("relay connection lost");
    // A long-lived process can get wedged in a connect-error loop (seen in
    // production: fresh processes connect, the old one keeps failing). After a
    // few consecutive failures, exit — Hermes respawns a fresh, healthy one.
    connectFailures++;
    if (connectFailures >= 5) {
      log("too many failed connections — exiting so Hermes respawns a fresh process");
      process.exit(1);
    }
    setTimeout(connectWs, 1000);
  };
  sock.onerror = (ev) => {
    log("socket error — will retry:", (ev && (ev.message || (ev.error && ev.error.message))) || "no detail");
    if (!loggedEnv) {
      loggedEnv = true;
      log(
        "env: node", process.version, "| WS_URL", process.env.APOLLO_WS_URL || "default",
        "| HTTP_PROXY", process.env.HTTP_PROXY || "-", "| HTTPS_PROXY", process.env.HTTPS_PROXY || "-",
        "| NO_PROXY", process.env.NO_PROXY || "-", "| NODE_OPTIONS", process.env.NODE_OPTIONS || "-"
      );
    }
    try {
      sock.close();
    } catch {}
  };
}

// request/response over the relay, keyed by an id unique to this process
const inflight = new Map(); // id -> { resolve, timer }
function relaySend(msg) {
  return new Promise((resolve, reject) => {
    const id = ++idCounter;
    const full = { ...msg, id };
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error(`relay timed out (${msg.t})`));
    }, msg.t === "call" ? TOOL_TIMEOUT_MS : 10_000);
    inflight.set(id, { resolve, timer });
    const payload = JSON.stringify(full);
    if (wsReady && ws) ws.send(payload);
    else wsQueue.push(full); // send() above would duplicate — push raw object
  });
}

function settle(id, msg) {
  const p = inflight.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  inflight.delete(id);
  p.resolve(msg);
}

function failAll(reason) {
  for (const [, p] of inflight) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  inflight.clear();
}

// --- MCP handlers -----------------------------------------------------------

async function handleRequest(req) {
  const method = req.method;
  const params = req.params || {};
  switch (method) {
    case "initialize":
      clientInitialized = true;
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "apollo", version: "0.1.0" },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications have no response
    case "ping":
      return {};
    case "tools/list": {
      const res = await relaySend({ t: "tools" });
      if (!res || res.ok === false) throw new Error((res && res.error) || "tools unavailable");
      return { tools: (res.result && res.result.tools) || [] };
    }
    case "tools/call": {
      const name = params.name;
      const args = params.arguments || {};
      const res = await relaySend({ t: "call", name, args });
      if (!res || res.ok === false) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: (res && (res.error || (res.result && res.result.error))) || "tool failed" }) }],
          isError: true,
        };
      }
      return mcpResult(res.result);
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// Convert the extension's { ok, result, image? } shape into an MCP tool result.
function mcpResult(result) {
  const content = [];
  if (result && result.image && result.image.data) {
    content.push({
      type: "image",
      data: result.image.data,
      mimeType: result.image.mediaType || "image/png",
    });
    content.push({
      type: "text",
      text: JSON.stringify({ ...result, image: undefined, note: result.note || "Screenshot attached." }),
    });
  } else {
    content.push({ type: "text", text: JSON.stringify(result) });
  }
  return { content, isError: false };
}

// --- wire up ----------------------------------------------------------------

connectWs();

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    log("dropping unparseable stdin line");
    return;
  }
  if (req.id === undefined) {
    // Notification — no response required.
    if (req.method === "notifications/initialized") { clientInitialized = true; log("client initialized"); }
    return;
  }
  (async () => {
    try {
      const result = await handleRequest(req);
      send({ jsonrpc: "2.0", id: req.id, result: result === undefined ? {} : result });
    } catch (e) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String((e && e.message) || e) } });
    }
  })();
});

rl.on("close", () => {
  log("stdin closed — exiting");
  process.exit(0);
});
