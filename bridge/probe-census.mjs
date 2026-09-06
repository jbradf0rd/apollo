// Probe Apollo relay state without hijacking the extension slot (safe per skill: {t:"tools"} census only)
// Requires Node >= 22 (global WebSocket client). Usage: node bridge/probe-census.mjs
const ws = new WebSocket("ws://127.0.0.1:8765");
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 15000);
ws.onopen = () => {
  ws.send(JSON.stringify({ t: "tools" }));
};
ws.onmessage = (ev) => {
  clearTimeout(timer);
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  console.log(JSON.stringify(msg, null, 1).slice(0, 2000));
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => { clearTimeout(timer); console.log("WS ERROR", e.message || e); process.exit(1); };
