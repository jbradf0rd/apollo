// End-to-end test of the Apollo bridge WITHOUT Chrome.
//
//   relay.mjs (real, on a test port)
//     ├── fake extension (Node global WebSocket client) — registers tools,
//     │      answers tool calls with canned results
//     └── mcp-server.mjs (real child process) — driven over stdio JSON-RPC
//            exactly like Hermes would: initialize → tools/list → tools/call
//
// Run:  node bridge/test-relay.mjs

import { spawn } from "node:child_process";
import readline from "node:readline";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log("  [test]", ...m);

// --- drive an MCP stdio child over JSON-RPC ---------------------------------

function spawnMcp(env) {
  const child = spawn(process.execPath, [path.join(here, "mcp-server.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let seq = 0;
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      w(msg);
    }
  });
  const rpc = (method, params, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, rpc };
}

// --- main --------------------------------------------------------------------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    log(`FAIL  ${name}: ${e.message}`);
  }
}

// 1. Start the relay on a test port.
const relay = spawn(process.execPath, [path.join(here, "relay.mjs"), `--port=${PORT}`], {
  stdio: ["ignore", "ignore", "inherit"],
});
await sleep(400);

// 2. Fake extension: real WS client (Node's global WebSocket), registers
//    canned tools, and answers calls from its side.
const extTools = [
  { name: "read_page", description: "Read the current page.", inputSchema: { type: "object", properties: {} } },
  { name: "click_element", description: "Click an element by ref.", inputSchema: { type: "object", properties: { ref: { type: "integer" } }, required: ["ref"] } },
];
const extCalls = [];
const ext = new WebSocket(WS_URL);
ext.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.t === "reg_ack") return log(`fake extension registered (ack: ${msg.tools})`);
  if (msg.t === "ping") return ext.send(JSON.stringify({ t: "pong" }));
  if (msg.t === "call") {
    extCalls.push(msg);
    if (msg.name === "read_page") {
      ext.send(JSON.stringify({ t: "res", id: msg.id, ok: true, result: { ok: true, title: "Example", url: "https://example.com", elements: [{ ref: 1, name: "Buy button" }] } }));
    } else {
      ext.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: "no such button" }));
    }
  }
};
await new Promise((resolve, reject) => {
  ext.onopen = resolve;
  ext.onerror = () => reject(new Error("fake extension could not connect"));
});
ext.send(JSON.stringify({ t: "reg", name: "fake-extension", tools: extTools, mutating: ["click_element"] }));
await sleep(300);

// 3. Drive mcp-server.mjs like Hermes would.
const { child: mcp, rpc } = spawnMcp({ APOLLO_WS_URL: WS_URL });

await check("initialize handshake", async () => {
  const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.ok(res.serverInfo.name === "apollo", `serverInfo.name = ${res.serverInfo.name}`);
  assert.ok(res.capabilities.tools, "advertises tools capability");
});

await check("tools/list proxies extension tool list", async () => {
  const res = await rpc("tools/list", {});
  assert.strictEqual(res.tools.length, 2, `expected 2 tools, got ${res.tools.length}`);
  assert.deepStrictEqual(res.tools[0].name, "read_page");
});

await check("tools/call executes via extension and returns result", async () => {
  const res = await rpc("tools/call", { name: "read_page", arguments: {} });
  assert.strictEqual(res.isError, false);
  const parsed = JSON.parse(res.content[0].text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "Example");
});

await check("tools/call error path surfaces as isError", async () => {
  const res = await rpc("tools/call", { name: "click_element", arguments: { ref: 99 } });
  assert.strictEqual(res.isError, true);
});

await check("tools/call with no extension connected reports cleanly", async () => {
  ext.close();
  await sleep(300); // relay notices the drop
  const res = await rpc("tools/call", { name: "read_page", arguments: {} });
  assert.strictEqual(res.isError, true);
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(/no extension connected/i.test(parsed.error), `error = ${parsed.error}`);
});

// --- teardown -----------------------------------------------------------------
mcp.stdin.end();
await sleep(200);
relay.kill();
await sleep(200);

const failed = results.filter(([, ok]) => !ok);
log(failed.length ? `\n${failed.length} test(s) FAILED` : "\nALL TESTS PASSED");
process.exit(failed.length ? 1 : 0);
