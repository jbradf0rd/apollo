// Live drive test: spawn bridge/mcp-server.mjs (the exact binary Hermes
// configured) and drive it over stdio JSON-RPC against the REAL extension.
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, "mcp-server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});
const rl = readline.createInterface({ input: child.stdout });
const waiting = new Map();
let seq = 0;
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { waiting.delete(id); rej(new Error("timeout " + method)); }, 20000);
  waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-test", version: "0" } });
const tabs = await rpc("tools/call", { name: "list_tabs", arguments: {} });
const tabList = JSON.parse(tabs.content[0].text);
console.log("=== live tabs through Hermes MCP path ===");
for (const t of tabList.tabs) console.log(`  [${t.active ? "ACTIVE" : "     "}] ${(t.title || "").slice(0, 70)}`);

// read the active tab; if it's a chrome:// page, hop to the first http(s) tab.
let target = tabList.tabs.find((t) => t.active);
let result = await rpc("tools/call", { name: "read_page", arguments: {} });
let parsed = JSON.parse(result.content[0].text);
if (!parsed.ok || !parsed.title) {
  const page = tabList.tabs.find((t) => /^https?:/.test(t.url || ""));
  if (page) {
    console.log("\n(active tab not readable — switching to:", (page.title || page.url).slice(0, 60) + ")");
    await rpc("tools/call", { name: "switch_tab", arguments: { tab_id: page.tab_id } });
    result = await rpc("tools/call", { name: "read_page", arguments: {} });
    parsed = JSON.parse(result.content[0].text);
  }
}
console.log("\n=== read_page result ===");
console.log("ok:", parsed.ok, "| title:", (parsed.title || "").slice(0, 90));
console.log("url:", parsed.url);
const els = (parsed.elements || []).slice(0, 8).map((e) => e.ref + ":" + String(e.name || "").replace(/\s+/g, " ").slice(0, 40));
console.log("elements:", els.join(" | "));
child.stdin.end();
process.exit(0);
