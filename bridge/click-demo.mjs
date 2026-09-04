// Visible demo: Hermes-path (MCP stdio) click on the live page.
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, "mcp-server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
const waiting = new Map();
let seq = 0;
rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => rej(new Error("timeout " + method)), 20000);
  waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => JSON.parse((await rpc("tools/call", { name, arguments: args })).content[0].text);

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "0" } });

// find a nav tab on the github repo page (the tab bar links)
const page = await call("read_page", {});
const found = (page.elements || []).find((e) => /^Pull requests/.test(String(e.name).trim()));
if (!found) { console.log("no Issues tab found. tab-bar-ish elements:", (page.elements || []).slice(0, 25).map(e => e.ref + ":" + String(e.name).slice(0, 30)).join(" | ")); process.exit(1); }
console.log(`clicking "${found.name}" (ref ${found.ref})`);
const res = await call("click_element", { ref: found.ref });
console.log("click result:", res.ok ? "OK" : "FAIL " + (res.error || ""));
if (res.ok !== false) {
  await call("wait", { seconds: 2 });
  const after = await call("read_page", {});
  console.log("page now:", after.title || "", "|", after.url || "");
}
child.stdin.end();
process.exit(0);
