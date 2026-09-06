// Apollo deterministic screenshots — README/promo imagery with zero personal data.
//
// Loads the REAL extension into Playwright Chromium, points it at a local mock
// model, drives the actual side panel on a served demo page, and captures:
//   01-panel-summary.png   completed turn (tool chip + bulleted answer)
//   02-panel-toolcall.png  mid-turn (tool executing, chip visible)
//   03-model-card.png      Settings → Model status card (REAL Hermes port)
//   04-continue-chip.png   panel footer with the "↗ Continue in Hermes" chip
//
// The relay (ws://127.0.0.1:8765) must be FREE before running: this Chromium's
// extension instance registers on it and would displace the real one. Shot 03
// spawns its own relay pinned to the `apollo` Hermes profile (needs a model +
// key in that profile's config/.env) and kills it when done; if the port is
// busy, shot 03 is skipped with a warning.
//
// Requires: npm install && npx playwright install chromium
// Run:       node scripts/screenshots.mjs
// Linux headless: xvfb-run -a node scripts/screenshots.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright";
import { STORAGE_KEY } from "../src/common/constants.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO, "media", "screenshots");
const RELAY = path.join(REPO, "bridge", "relay.mjs");
const RELAY_PORT = 8765;

// --- Demo page the agent will read (clean, fictional, no third-party data) ---
const DEMO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Atlas Widget — Product Overview</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 system-ui, 'Segoe UI', sans-serif; color: #202124; }
  header { display: flex; align-items: center; gap: 24px; padding: 14px 40px; border-bottom: 1px solid #e8eaed; }
  .logo { font-weight: 700; font-size: 18px; }
  header nav { display: flex; gap: 18px; color: #5f6368; flex: 1; }
  .cta { background: #1a73e8; color: #fff; border-radius: 20px; padding: 8px 18px; font-weight: 500; }
  .hero { padding: 64px 40px 40px; text-align: center; }
  .hero h1 { font-size: 34px; margin-bottom: 12px; }
  .hero p { color: #5f6368; max-width: 640px; margin: 0 auto 24px; }
  .btns { display: flex; gap: 12px; justify-content: center; }
  .btn { padding: 10px 22px; border-radius: 22px; font-weight: 500; }
  .btn.primary { background: #1a73e8; color: #fff; }
  .btn.ghost { border: 1px solid #dadce0; color: #1a73e8; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 8px 40px 40px; }
  .card { border: 1px solid #e8eaed; border-radius: 12px; padding: 22px; }
  .card h3 { margin-bottom: 8px; font-size: 17px; }
  .card p { color: #5f6368; font-size: 14px; }
  .price { padding: 24px 40px; background: #f8f9fa; border-top: 1px solid #e8eaed; text-align: center; }
  .price b { font-size: 22px; }
</style></head>
<body>
  <header><span class="logo">Atlas</span>
    <nav><span>Products</span><span>Docs</span><span>Pricing</span><span>Support</span></nav>
    <span class="cta">Get started</span></header>
  <div class="hero">
    <h1>Atlas Widget</h1>
    <p>The single-board controller for machine builders — 24 I/O, CAN and USB-C on one 30&nbsp;mm board.</p>
    <div class="btns"><span class="btn primary">Buy now</span><span class="btn ghost">Read the docs</span></div>
  </div>
  <div class="cards">
    <div class="card"><h3>24 isolated I/O</h3><p>5&nbsp;V&ndash;24&nbsp;V logic range, per-channel isolation, and a firmware-free UART bootloader.</p></div>
    <div class="card"><h3>CAN 2.0B + USB-C</h3><p>Speak the bus your machines already use; console over the cable you already carry.</p></div>
    <div class="card"><h3>3&nbsp;W average draw</h3><p>Runs for years on a single cell — built for field work, not just the bench.</p></div>
  </div>
  <div class="price">Pricing starts at <b>$29</b> · documentation and CAD files ship with every unit.</div>
</body></html>`;

// Canned model replies. Turn 1 (no tool result yet): read the page.
// Turn 2 (get_page_text result present): a bulleted answer.
// The answer is delayed ~1.2s so shot 02 can capture the tool chip mid-run.
const ANSWER = `Here are the three highlights:\n\n• Atlas Widget is a single-board machine controller — 24 isolated I/O, CAN 2.0B, and USB-C.\n• Wide 5–24 V logic range and a firmware-free bootloader make integration fast.\n• 3 W average draw and a $29 starting price make it friendly for field use.`;

function sse(res, events, delayMs = 0, finishReason = "stop") {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  const finish = () => {
    send({ choices: [{ delta: { role: "assistant" } }] });
    for (const e of events) send(e);
    send({ choices: [{ finish_reason: finishReason }] });
    res.write("data: [DONE]\n\n");
    res.end();
  };
  delayMs ? setTimeout(finish, delayMs) : finish();
}

function mockServer() {
  return http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
      return res.end();
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(DEMO_PAGE);
    }
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify({ data: [{ id: "apollo-shot-model" }] }));
    }
    if (req.url.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let messages = [];
        try { messages = JSON.parse(body).messages || []; } catch { /* keep going */ }
        const sawToolResult = messages.some((m) => m.role === "tool");
        if (!sawToolResult) {
          // Turn 1: ask for the page text.
          return sse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_shot", function: { name: "get_page_text", arguments: "{}" } }] } }] },
          ], 0, "tool_calls");
        }
        // Turn 2: the bulleted answer, slightly delayed for the mid-run shot.
        return sse(res, [{ choices: [{ delta: { content: ANSWER } }] }], 1200);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const portFree = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(RELAY_PORT, "127.0.0.1");
  });

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shots = [];

  const server = mockServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "apollo-shots-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${REPO}`,
      `--load-extension=${REPO}`,
    ],
  });

  let relay = null;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    console.log(`extension id: ${extId}`);

    // Seed config: the mock provider, auto autonomy.
    const optPage = await context.newPage();
    await optPage.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
    const config = {
      providers: [
        { id: "mock", name: "Shot model", type: "openai", baseUrl: `${base}/v1`, apiKey: "shot", model: "apollo-shot-model", models: ["apollo-shot-model"] },
      ],
      activeProviderId: "mock",
      activeModel: "apollo-shot-model",
      sitePermissions: {},
      settings: { autonomy: "auto", maxSteps: 15, maxTokens: 1024, temperature: 0.4, enableVision: false, enableJsTool: false, enableCdp: false },
    };
    await optPage.evaluate(([key, cfg]) => chrome.storage.local.set({ [key]: cfg }), [STORAGE_KEY, config]);
    await optPage.close();

    // The page the agent acts on.
    const page = await context.newPage();
    await page.goto(`${base}/page`, { waitUntil: "load" });

    // The real side panel.
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 800 });
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "load" });
    await panel.waitForSelector("#input", { timeout: 10000 });
    await panel.waitForFunction(() => !document.querySelector("#input")?.disabled, null, { timeout: 10000 });
    // The agent acts on the ACTIVE tab — make the demo page the target while
    // the panel stays open for screenshots (Playwright captures non-front pages).
    await page.bringToFront();

    // Drive the composer like a user.
    await panel.fill("#input", "Summarize this page in three bullets.");
    await panel.click("#send-btn");

    // Mid-run: the tool chip is visible while the mock "reads" the page.
    await panel.waitForFunction(() => document.body.innerText.includes("get_page_text"), null, { timeout: 15000 });
    await panel.screenshot({ path: path.join(OUT_DIR, "02-panel-toolcall.png"), scale: "device" });
    shots.push("02-panel-toolcall.png");

    // Completed: the bulleted answer rendered.
    await panel.waitForFunction(() => document.body.innerText.includes("Atlas Widget is a single-board"), null, { timeout: 15000 });
    await panel.screenshot({ path: path.join(OUT_DIR, "01-panel-summary.png"), scale: "device" });
    shots.push("01-panel-summary.png");

    // Continue-in-Hermes chip appears after a completed conversation.
    await panel.waitForSelector("#hermes-handoff:not([hidden])", { timeout: 15000 });
    await panel.screenshot({ path: path.join(OUT_DIR, "04-continue-chip.png"), scale: "device" });
    shots.push("04-continue-chip.png");
    console.log("panel shots done");

    // --- Shot 05: the panel BESIDE the page, in a Chrome-style frame. --------
    // Real captures of both surfaces; the window chrome (tabs/omnibox/toolbar)
    // is drawn by the script so the whole thing stays deterministic.
    {
      const PW = 1240, PH = 700;
      await page.setViewportSize({ width: PW, height: PH });
      await page.bringToFront();
      const pageShot = await page.screenshot({ scale: "device" });
      await panel.setViewportSize({ width: 420, height: PH });
      const panelShot = await panel.screenshot({ scale: "device" });
      const icon = fs.readFileSync(path.join(REPO, "icons", "icon32.png"));
      const b64 = (b) => b.toString("base64");
      const frame = `<!doctype html><html><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; margin: 0; }
        html, body { overflow: hidden; }
        body { font: 13px/1.4 system-ui, 'Segoe UI', sans-serif; background: #e8eaed; padding: 28px; width: max-content; }
        .win { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 36px rgba(0,0,0,.22); }
        .tabstrip { display: flex; align-items: center; background: #dee1e6; padding: 10px 14px 0; gap: 8px; }
        .tab { display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 10px 10px 0 0; padding: 8px 18px 8px 12px; }
        .tab .dot { width: 14px; height: 14px; border-radius: 50%; background: #1a73e8; }
        .tab .ttl { font-weight: 500; color: #202124; }
        .tab .x { color: #5f6368; font-size: 11px; }
        .newtab { color: #5f6368; padding: 8px 10px; }
        .spacer { flex: 1; }
        .bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid #e8eaed; }
        .nav { color: #5f6368; letter-spacing: 2px; }
        .omnibox { flex: 1; background: #f1f3f4; border-radius: 22px; padding: 7px 16px; color: #3c4043; }
        .omnibox .lock { color: #5f6368; margin-right: 6px; }
        .ext { position: relative; width: 22px; height: 22px; }
        .badge { position: absolute; right: -3px; bottom: -3px; background: #188038; color: #fff; border-radius: 8px; font-size: 9px; padding: 0 4px; line-height: 13px; }
        .body { display: flex; }
        .page img, .panel img { display: block; }
        .panel { border-left: 1px solid #e8eaed; }
      </style></head><body>
        <div class="win">
          <div class="tabstrip">
            <div class="tab"><span class="dot"></span><span class="ttl">Atlas Widget — Product Overview</span><span class="x">✕</span></div>
            <span class="newtab">＋</span>
            <span class="spacer"></span>
            <span style="color:#5f6368">⋮</span>
          </div>
          <div class="bar">
            <span class="nav">←  →  ⟳</span>
            <div class="omnibox"><span class="lock">🔒</span>127.0.0.1:${server.address().port}/page</div>
            <div class="ext"><img width="22" height="22" src="data:image/png;base64,${b64(icon)}"><span class="badge">✓ 17</span></div>
          </div>
          <div class="body">
            <div class="page"><img width="${PW}" height="${PH}" src="data:image/png;base64,${b64(pageShot)}"></div>
            <div class="panel"><img width="420" height="${PH}" src="data:image/png;base64,${b64(panelShot)}"></div>
          </div>
        </div>
      </body></html>`;
      const framePage = await context.newPage();
      await framePage.setViewportSize({ width: PW + 420 + 84, height: PH + 150 });
      await framePage.setContent(frame, { waitUntil: "load" });
      await framePage.screenshot({ path: path.join(OUT_DIR, "05-panel-beside-page.png"), scale: "device" });
      await framePage.close();
      shots.push("05-panel-beside-page.png");
      console.log("composite shot done");
    }

    // --- Shot 03: Model status card with a REAL Hermes port. -----------------
    const free = await portFree();
    if (!free) {
      console.log("!! port 8765 busy — skipping 03-model-card.png (kill the live relay and re-run)");
    } else {
      relay = spawn(process.execPath, [RELAY], {
        env: { ...process.env, APOLLO_HERMES_PROFILE: "apollo" },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await new Promise((r) => setTimeout(r, 4000)); // relay boot + SW reconnect + port
      const card = await context.newPage();
      await card.setViewportSize({ width: 560, height: 700 });
      await card.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
      try {
        await card.waitForFunction(
          () => (document.querySelector("#model-status-line") || {}).textContent?.includes("Hermes:") || "",
          null,
          { timeout: 30000 }
        );
        await card.screenshot({ path: path.join(OUT_DIR, "03-model-card.png"), scale: "device" });
        shots.push("03-model-card.png");
      } catch {
        console.log("!! model card did not show a Hermes port (apollo profile not configured?) — skipped");
      }
      await card.close();
    }
  } finally {
    await context.close();
    if (relay) { relay.kill(); await new Promise((r) => setTimeout(r, 500)); }
    server.close();
  }

  console.log("\nDone. Wrote to media/screenshots/:");
  for (const s of shots) console.log("  " + s);
}

main().catch((e) => { console.error(e); process.exit(1); });
