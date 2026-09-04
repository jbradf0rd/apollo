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
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
// "" (default) = follow Hermes's ACTIVE provider via the default profile —
// this channel now exists ONLY for the bridge fallback (models with no
// browser key, e.g. claude via OAuth), so it must match whatever Joe has
// selected, not a pinned profile. Set APOLLO_HERMES_PROFILE to pin.
const HERMES_PROFILE = process.env.APOLLO_HERMES_PROFILE || "";
const HERMES_MODEL = process.env.APOLLO_HERMES_MODEL || ""; // override (empty = follow config)
const CHAT_MAX_MS = 420000;

// ---- Artifact sink: panel conversations land here as markdown ---------------
// One file per conversation (rotated when the extension starts a new chat),
// overwritten each turn so the file is always the latest full transcript.
function hermesHomeDir() {
  return process.env.HERMES_HOME || path.join(os.homedir(), "AppData", "Local", "hermes");
}
const ARTIFACTS_DIR = process.env.APOLLO_ARTIFACTS_DIR || path.join(hermesHomeDir(), "artifacts", "apollo-panel");
let artifactCurrent = null; // { convoId, file }
function writeArtifact(msg) {
  try {
    if (!msg.convoId || typeof msg.markdown !== "string" || !msg.markdown) return;
    if (!artifactCurrent || artifactCurrent.convoId !== msg.convoId) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      mkdirSync(ARTIFACTS_DIR, { recursive: true });
      artifactCurrent = { convoId: msg.convoId, file: path.join(ARTIFACTS_DIR, `apollo-${stamp}.md`) };
      log("artifact file:", artifactCurrent.file);
    }
    writeFileSync(artifactCurrent.file, msg.markdown, "utf8");
  } catch (e) {
    log("artifact write failed:", e.message);
  }
}

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
      runHermesChat(msg.id, String(msg.text || ""), conn, msg.quiet === true);
      return;
    }
    default:
      if (msg.id != null) return send(conn, { t: "res", id: msg.id, ok: false, error: "unknown chat message: " + msg.t });
  }
}

function runHermesChat(id, text, conn, quiet) {
  // -Q: quiet one-shot — stdout carries ONLY the assistant's reply (no banners
  // or session summary), so deltas can stream straight to the panel.
  // No -p profile pin by default: the chat channel serves the BRIDGE FALLBACK
  // (active model has no browser key, e.g. claude), which must use Joe's ACTIVE
  // provider — including claude via its OAuth subscription.
  const args = [];
  if (HERMES_PROFILE) args.push("-p", HERMES_PROFILE);
  args.push("chat", "--query-file", "-", "-Q", "--continue", chatState.sessionKey, "--create-if-missing");
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
    // Strip ANSI escape sequences + CRs, and drop Hermes's cosmetic model-
    // normalization notices — the panel renders only the reply.
    const chunk = d
      .toString("utf8")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\r/g, "")
      .replace(/⚠️\s*Normalized model[^\n]*\n?/g, "");
    stdout += chunk;
    // Forward as it arrives — the panel can stream the reply live. Quiet
    // mode (Continue-in-Hermes handoff) suppresses deltas; only the final res.
    if (!quiet) sendToExt({ t: "chat_delta", id, text: chunk });
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
      sendToExt({ t: "chat_res", id, ok: true, text: textOut, session: chatState.sessionKey });
    } else if (!textOut) {
      const err = (stderr.trim() || `hermes exited with code ${code}`).split("\n").pop().slice(0, 400);
      log("chat failed:", err);
      sendToExt({ t: "chat_res", id, ok: false, error: err });
    } else {
      // Nonzero exit but produced text — deliver what we got.
      log("chat exited", code, "with text:", textOut.length, "chars");
      sendToExt({ t: "chat_res", id, ok: true, text: textOut, session: chatState.sessionKey });
    }
  });

  // Feed the query via stdin (--query-file -) — safe for arbitrary text.
  child.stdin.write(text);
  child.stdin.end();
}

// Read Hermes's ACTIVE model/provider (the one Joe selects in his main chat)
// and map it to the extension's matching adapter so the panel talks straight to
// the SAME model. Reads the DEFAULT profile's config.yaml — that's what Joe
// switches — plus .env for keys. Maps provider -> {openai|anthropic} adapter and
// resolves the key per provider. Returns { provider, model, baseUrl, apiKey,
// type, reachable, reason } — reachable:false when no key exists for that
// provider (e.g. anthropic via OAuth, which has no portable API key), so the
// caller can tell Joe honestly instead of silently substituting another model.
function readHermesProvider() {
  try {
    const home = process.env.HERMES_HOME || path.join(os.homedir(), "AppData", "Local", "hermes");
    // DEFAULT profile = what Joe selects in his main chat. Follow it. (An env
    // override is allowed for a pinned setup, but the default is to follow.)
    const profile = process.env.APOLLO_HERMES_PROFILE || "";
    const cfgPath = profile
      ? path.join(home, "profiles", profile, "config.yaml")
      : path.join(home, "config.yaml");
    const cfg = readFileSync(cfgPath, "utf8").replace(/\r/g, "");
    const block = (cfg.match(/^model:[ \t]*\n((?:[ \t]+.*\n?)*)/m) || [])[1] || "";
    const grab = (k) => {
      const m = block.match(new RegExp("^ {2}" + k + ":[ \\t]*([^\\n]+)", "m"));
      return m ? m[1].trim() : "";
    };
    const provider = (grab("provider") || "deepseek").toLowerCase();
    const model = grab("default") || "";
    const cfgBase = grab("base_url");
    const cfgKey = grab("api_key");

    // .env: profile-local first (if pinned), then shared root .env.
    const readEnv = (dir) => {
      try { return readFileSync(path.join(dir, ".env"), "utf8").replace(/\r/g, ""); } catch { return ""; }
    };
    const envText =
      (profile ? readEnv(path.join(home, "profiles", profile)) + "\n" : "") + readEnv(home);
    const getEnv = (k) => {
      const m = envText.match(new RegExp("^" + k + "=(.*)$", "m"));
      return m ? m[1].trim() : "";
    };

    // Provider -> adapter type + endpoint + key source.
    //   anthropic  -> extension's "anthropic" adapter (Messages API, direct-browser CORS)
    //   everything else speaks OpenAI /chat/completions ("openai" adapter)
    let type = "openai", baseUrl = "", apiKey = "";
    switch (provider) {
      case "anthropic":
        type = "anthropic";
        baseUrl = cfgBase && cfgBase !== "local" ? cfgBase : "https://api.anthropic.com/v1";
        if (!/\/v1$/.test(baseUrl)) baseUrl = baseUrl.replace(/\/+$/, "") + "/v1";
        apiKey = getEnv("ANTHROPIC_API_KEY"); // OAuth-based subscriptions have NONE
        break;
      case "deepseek":
        baseUrl = getEnv("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1";
        apiKey = getEnv("DEEPSEEK_API_KEY");
        break;
      case "gemini":
      case "google":
        // Gemini's OpenAI-compatible endpoint.
        baseUrl = getEnv("GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai";
        apiKey = getEnv("GEMINI_API_KEY");
        break;
      case "openai":
        baseUrl = getEnv("OPENAI_BASE_URL") || "https://api.openai.com/v1";
        apiKey = getEnv("OPENAI_API_KEY");
        break;
      case "custom":
        baseUrl = cfgBase;
        apiKey = cfgKey || "local"; // local endpoints accept any key
        break;
      default:
        log("provider port: unknown provider", provider, "(left extension provider unchanged)");
        return null;
    }

    if (!model || !baseUrl) return null;
    // "local" custom key is fine (local server ignores it). For real cloud
    // providers a missing key means we CANNOT call it directly.
    const reachable = provider === "custom" ? true : !!apiKey;
    const reason = reachable
      ? ""
      : `no API key for '${provider}' (Hermes reaches it via OAuth/subscription — not a portable key)`;
    return { provider, model, baseUrl, apiKey, type, reachable, reason };
  } catch (e) {
    log("provider read failed:", e.message);
    return null;
  }
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
    case "artifact":
      writeArtifact(msg);
      return;
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
      send(conn, { t: "reg_ack", tools: ext.tools.length });
      // Port Hermes's active model/provider into the extension so the lean
      // panel agent talks straight to the same model Hermes uses.
      const provider = readHermesProvider();
      if (provider) {
        if (provider.reachable) {
          log("ported Hermes provider:", provider.provider, provider.model, "(" + provider.type + ") →", provider.baseUrl);
        } else {
          log("Hermes active provider", provider.provider, provider.model, "is NOT directly reachable:", provider.reason);
        }
        send(conn, { t: "provider", ...provider });
      }
      return;
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
