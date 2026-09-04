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
