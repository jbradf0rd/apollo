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
const wsQueue = []; // JSON messages queued until the socket is up

function connectWs() {
  log(`connecting to relay at ${WS_URL}...`);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    log("WebSocket construction failed:", e.message);
    setTimeout(connectWs, 2000);
    return;
  }
  ws.onopen = () => {
    log("relay connected");
    wsReady = true;
    for (const m of wsQueue.splice(0)) ws.send(JSON.stringify(m));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === "res") settle(msg.id, msg);
    else if (msg.t === "pong") {/* keepalive reply */}
    else log("unexpected relay message:", msg.t);
  };
  ws.onclose = () => {
    log("relay connection lost");
    wsReady = false;
    ws = null;
    // Fail any in-flight calls so Hermes doesn't hang forever.
    failAll("relay connection lost");
    setTimeout(connectWs, 1000);
  };
  ws.onerror = () => {
    try {
      ws.close();
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
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
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
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: (res && res.error) || "tool failed" }) }],
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
    if (req.method === "notifications/initialized") log("client initialized");
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
