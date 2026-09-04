# Apollo bridge — connect Hermes to the Apollo browser extension

Two tiny zero-dependency Node processes turn the Apollo (fork of OpenSidekick)
Chrome extension into a browser tool surface for **Hermes Agent**. Hermes runs
the agent loop; the extension keeps its DOM reader/actor (element refs, clicks,
typing, real logged-in sessions); the bridge carries tool calls between them.

```
Hermes agent (any session)            Chrome
        │  stdio MCP                    │
        ▼                               ▼
  mcp-server.mjs ──WS──► relay.mjs ◄──WS── extension (src/background/relay.js)
  (spawned by Hermes)    (always-on)     (connects out — MV3 can't listen)
```

- `relay.mjs` — always-on daemon. Owns the one listener the extension connects
  out to; multiplexes any number of Hermes MCP processes onto the single
  extension socket. Wire protocol is JSON text frames (documented in the file).
- `mcp-server.mjs` — Model Context Protocol server over stdio, spawned by
  Hermes (`hermes mcp add`). Proxies `tools/list` / `tools/call` to the relay.
  Logs only to stderr; stdout is reserved for JSON-RPC.
- `ws-server.mjs` — minimal RFC 6455 WebSocket server (no npm deps).
- `test-relay.mjs` — end-to-end test of the whole chain without Chrome
  (fake extension + real MCP handshake): `node bridge/test-relay.mjs`.

## Run

```bash
# 1. Relay daemon (keep running)
node bridge/relay.mjs                       # ws://127.0.0.1:8765

# 2. Load the extension unpacked in Chrome:
#    chrome://extensions → Developer mode → Load unpacked → this repo folder

# 3. Register the MCP server with Hermes (one time):
hermes mcp add apollo --command node --args <abs path>/bridge/mcp-server.mjs
#    answer: requires authentication? n   ·   enable all tools? Y

# 4. Use in a fresh Hermes session — tools appear as mcp_apollo_<tool>
```

## Safety

Mutating tools (`click_element`, `type_text`, `navigate`, …) run only while the
extension config flag `hermesRelay.allowMutating` is true (default true — that
is the point of the bridge). Set it `false` for a read-only relay. The full
per-site permission and approval layer is ported to this path separately.

## Layout

Extension changes stay in `src/background/relay.js` (WS client, tool
registration, tool execution) + the `startRelay()` hooks in
`service-worker.js`. Everything under `bridge/` is standalone Node.
