// apollo-drive.mjs — issue one Apollo browser-tool call via the relay WS (control client, no ext-slot hijack)
// Requires Node >= 22 (global WebSocket client). Usage: node bridge/apollo-drive.mjs <toolName> '<jsonArgs>'
const toolName = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
if (!toolName) { console.log("usage: node apollo-drive.mjs <tool> '[json-args]'"); process.exit(1); }

const ws = new WebSocket("ws://127.0.0.1:8765");
const timer = setTimeout(() => { console.log("TIMEOUT waiting for relay"); process.exit(2); }, 45000);
ws.onopen = () => ws.send(JSON.stringify({ t: "call", name: toolName, args }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (msg.t === "res" && msg.id === undefined && (msg.req === toolName || msg.result !== undefined || msg.ok !== undefined)) {
    clearTimeout(timer);
    console.log(JSON.stringify(msg, null, 1));
    ws.close();
    process.exit(msg.ok === false ? 3 : 0);
  }
};
ws.onerror = (e) => { clearTimeout(timer); console.log("WS ERROR", e.message || e); process.exit(1); };
