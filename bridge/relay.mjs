// Apollo relay daemon — the always-on local bridge between Chrome and Hermes.
//
//   Chrome extension ──WS──► relay.mjs ◄──WS── mcp-server.mjs (spawned by Hermes)
//
// Why a separate always-on process: Hermes spawns a fresh MCP server process
// per session, and Chrome extensions cannot LISTEN on a socket — the extension
// must connect out. The relay owns the single listener; any number of Hermes
// MCP processes connect to it as "control" clients, and the one connected
// extension is the browser hand.
//
// Wire protocol (JSON text frames, localhost only):
//   ext -> relay    {"t":"reg","tools":[...], "mutating":[...]}   on connect
//   hermes -> relay {"t":"tools"}                                  list request
//   relay -> hermes {"t":"tools","tools":[...]}                    (or error)
//   hermes -> relay {"t":"call","id":N,"name":"read_page","args":{}}
//   relay -> ext    {"t":"call","id":N,"name":...,"args":{...}}
//   ext -> relay    {"t":"res","id":N,"ok":true,"result":{...}}
//   relay -> hermes {"t":"res","id":N,"ok":...,"result":...}
//   either side     {"t":"ping"} / {"t":"pong"}                   keepalive
//
// Run:  node bridge/relay.mjs [--port 8765] [--host 127.0.0.1]

import http from "node:http";
import { spawn } from "node:child_process";
import { attachWs } from "./ws-server.mjs";

const args = process.argv.slice(2);
const port = Number((args.find((a) => a.startsWith("--port=")) || "--port=8765").split("=")[1]);
const host = (args.find((a) => a.startsWith("--host=")) || "--host=127.0.0.1").split("=")[1];

const log = (...m) => console.error("[apollo-relay]", ...m); // stderr — never stdout

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("apollo-relay: WebSocket bridge for the Apollo browser agent\n");
});

const hub = attachWs(server);

let ext = null; // { conn, tools, mutating, name }
let nextCallId = 1;
const pending = new Map(); // callId -> control conn

let connCount = 0;
hub.on("connection", (conn) => {
  connCount++;
  conn.on("text", (raw) => handleMessage(conn, raw));
  conn.on("close", () => {
    connCount--;
    if (ext && ext.conn === conn) {
      ext = null;
      log("extension disconnected");
      // Fail in-flight calls that were waiting on the extension.
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        send(entry.conn, { t: "res", id: entry.clientId, ok: false, error: "extension disconnected" });
      }
      // A chat that was waiting on a reply is also unresolvable.
      if (chatState.extConn === conn) {
        chatState.extConn = null;
        if (chatState.child) killChatChild();
      }
    } else if (pending.size) {
      // Drop calls that were waiting on this control connection.
      for (const [id, entry] of [...pending]) {
        if (entry.conn === conn) {
          pending.delete(id);
          send(conn, { t: "res", id: entry.clientId, ok: false, error: "control connection closed" });
        }
      }
    }
    log(`connection closed (${connCount} open)`);
  });
  log(`connection opened (${connCount} open)`);
});

// --- chat channel: extension <-> a resumable `hermes chat` session ----------
// The side panel's composer talks to Hermes itself (memory, skills, MCP stack)
// rather than a raw model. Each message spawns one `hermes chat` one-shot that
// continues the SAME named session, so the panel keeps one conversation. Chats
// are serialized — one at a time.
const chatState = {
  extConn: null, // connection of the extension that owns the chat
  child: null, // running hermes process
  busy: false,
  sessionKey: "apollo-panel",
};
const HERMES_CMD = process.env.APOLLO_HERMES_CMD || "hermes";
const HERMES_MODEL = process.env.APOLLO_HERMES_MODEL || ""; // e.g. "apollo-local" — empty = profile default (cloud)
const CHAT_MAX_MS = 420000;

function sendToExt(msg) {
  if (chatState.extConn && ext && ext.conn === chatState.extConn) send(ext.conn, msg);
}

function killChatChild() {
  if (chatState.child) {
    try {
      chatState.child.kill();
    } catch {}
    chatState.child = null;
  }
}

// Route chat messages. `conn` must be the registered extension connection.
function handleChatMessage(conn, msg) {
  switch (msg.t) {
    case "chat_new":
      chatState.sessionKey = "apollo-panel-" + Date.now();
      chatState.extConn = conn;
      log("new chat → session key:", chatState.sessionKey);
      return send(conn, { t: "chat_ack", id: msg.id });
    case "chat_abort":
      if (chatState.child) {
        log("aborting chat");
        killChatChild();
      }
      chatState.busy = false;
      return send(conn, { t: "chat_ack", id: msg.id });
    case "chat": {
      chatState.extConn = conn;
      if (chatState.busy) {
        return send(conn, { t: "chat_res", id: msg.id, ok: false, error: "A chat is already running." });
      }
      chatState.busy = true;
      runHermesChat(msg.id, String(msg.text || ""), conn);
      return;
    }
    default:
      if (msg.id != null) return send(conn, { t: "res", id: msg.id, ok: false, error: "unknown chat message: " + msg.t });
  }
}

function runHermesChat(id, text, conn) {
  // -Q: quiet one-shot — stdout carries ONLY the assistant's reply (no banners
  // or session summary), so deltas can stream straight to the panel.
  // APOLLO_HERMES_MODEL selects the model/provider (a model alias like
  // "apollo-local" for the on-box box); empty = the profile default (cloud).
  const args = ["chat", "--query-file", "-", "-Q", "--continue", chatState.sessionKey, "--create-if-missing"];
  if (HERMES_MODEL) args.push("-m", HERMES_MODEL);
  log("spawning hermes:", HERMES_CMD, args.join(" "));
  let child;
  try {
    child = spawn(HERMES_CMD, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    chatState.busy = false;
    return send(conn, { t: "chat_res", id, ok: false, error: "Could not start hermes: " + (e.message || e) });
  }
  chatState.child = child;
  const timer = setTimeout(() => {
    log("chat timed out after", CHAT_MAX_MS, "ms");
    killChatChild();
  }, CHAT_MAX_MS);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    // Strip ANSI escape sequences + CRs — the panel renders plain text.
    const chunk = d.toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
    stdout += chunk;
    // Forward as it arrives — the panel can stream the reply live.
    sendToExt({ t: "chat_delta", id, text: chunk });
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    chatState.busy = false;
    chatState.child = null;
    sendToExt({ t: "chat_res", id, ok: false, error: "hermes failed to start: " + (e.message || e) });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    chatState.busy = false;
    chatState.child = null;
    const textOut = stdout.trim();
    if (code === 0 && textOut) {
      log("chat reply ok:", textOut.length, "chars");
      sendToExt({ t: "chat_res", id, ok: true, text: textOut });
    } else if (!textOut) {
      const err = (stderr.trim() || `hermes exited with code ${code}`).split("\n").pop().slice(0, 400);
      log("chat failed:", err);
      sendToExt({ t: "chat_res", id, ok: false, error: err });
    } else {
      // Nonzero exit but produced text — deliver what we got.
      log("chat exited", code, "with text:", textOut.length, "chars");
      sendToExt({ t: "chat_res", id, ok: true, text: textOut });
    }
  });

  // Feed the query via stdin (--query-file -) — safe for arbitrary text.
  child.stdin.write(text);
  child.stdin.end();
}

function send(conn, obj) {
  try {
    conn.send(JSON.stringify(obj));
  } catch (e) {
    log("send failed:", e.message);
  }
}

function handleMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(conn, { t: "error", error: "bad json" });
  }
  switch (msg.t) {
    case "ping":
      return send(conn, { t: "pong" });
    case "chat":
    case "chat_new":
    case "chat_abort":
      // Chat channel — only the registered extension may drive it.
      if (!ext || ext.conn !== conn) {
        if (msg.id != null) return send(conn, { t: "chat_res", id: msg.id, ok: false, error: "not the registered extension" });
        return;
      }
      return handleChatMessage(conn, msg);
    case "reg": {
      // A tool-carrying client = the browser extension.
      ext = { conn, tools: msg.tools || [], mutating: msg.mutating || [], name: msg.name || "extension" };
      log(`extension registered: ${ext.tools.length} tools, ${ext.mutating.length} mutating`);
      // Announce tools to any control client that asked while we had none.
      return send(conn, { t: "reg_ack", tools: ext.tools.length });
    }
    case "tools": {
      if (!ext) return send(conn, { t: "res", id: msg.id, ok: false, error: "no extension connected" });
      // Request/response replies are always shaped { t:"res", id, ok, result|error }
      // so control clients (the MCP server) settle them uniformly.
      return send(conn, { t: "res", id: msg.id, ok: true, result: { tools: ext.tools, mutating: ext.mutating } });
    }
    case "call": {
      if (!ext) return send(conn, { t: "res", id: msg.id, ok: false, error: "no extension connected" });
      // The extension leg gets a relay-scoped id; remember the caller's own id
      // so the reply is translated back (control clients key on their counter).
      const relayId = nextCallId++;
      pending.set(relayId, { conn, clientId: msg.id });
      log(`tool call #${relayId}: ${msg.name}`);
      send(ext.conn, { t: "call", id: relayId, name: msg.name, args: msg.args || {} });
      return;
    }
    case "res": {
      const origin = pending.get(msg.id);
      if (!origin) return; // late reply — caller gone
      pending.delete(msg.id);
      log(`tool result #${msg.id}: ok=${msg.ok !== false}`);
      return send(origin.conn, { t: "res", id: origin.clientId, ok: msg.ok !== false, result: msg.result, error: msg.error });
    }
    default:
      if (msg.id != null) return send(conn, { t: "res", id: msg.id, ok: false, error: "unknown message type: " + msg.t });
      return send(conn, { t: "error", error: "unknown message type: " + msg.t });
  }
}

// Heartbeat the extension so intermediate NAT/proxies (and Chrome's own idle
// accounting) see a live socket. Control connections are short-lived.
setInterval(() => {
  if (ext) ext.conn.ping?.();
}, 20000).unref?.();

server.listen(port, host, () => log(`listening on ws://${host}:${port}`));
