# Changelog

All notable changes to **Apollo — Hermes-Driven Browser Agent** (fork of OpenSidekick) are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: fork versions start at 0.2.0 (upstream was 0.1.7 at fork time).

## [0.2.4] — 2026-09-03

### Added
- **Hermes-bridge fallback for models with no browser key.** When Hermes's active model is unreachable from the browser (e.g. claude via an OAuth subscription — no portable API key exists), panel messages now route through the Hermes bridge (`hermes chat` on the active profile) instead of erroring or silently using a stale provider. Relay spawns `hermes chat` with **no `-p` profile pin**, so it follows the model Joe has active in Hermes, claude included.
- **Bridge-fallback toast** (`chrome.notifications`): one-time "Bridge fallback" alert per engagement, explaining why the reply is slower; resets when a keyed provider ports back in.
- `GET_STATE` now exposes `bridgeFallback`, `hermesPortNote`, `hermesActiveModel`, `hermesActiveProvider` for UI.

### Fixed
- **Provider port now FOLLOWS Hermes's active model instead of being pinned to deepseek.** The port reads the *default* Hermes profile (what the user selects in their main chat) and maps `model.provider` to the extension's matching adapter. Previously it read a pinned profile (and before that, mixed the default profile's active model — e.g. claude-opus — with deepseek's endpoint, which the API rejected with HTTP 400).
- `applyHermesProvider` stores the ported adapter `type` (anthropic vs openai); before, hardcoded `type: "openai"` would have sent claude through the wrong wire protocol.
- Unreachable providers no longer leave a stale provider active: `handleRunTask` checks the port note **first**, so the panel never silently answers with a model Hermes isn't on.
- YAML parsing of Hermes `config.yaml`: CRLF stripping + a block regex that captures all indented lines (the `$`-with-`m`-flag bug read only the first config line).
- Hermes `config.yaml` provider/base_url written by model switches in the desktop app are now honored (the port reads the live config each time).

### Notes
- `hermes chat --ignore-rules` does **not** work for the fallback (it breaks provider resolution — a `-m anthropic/claude-opus-4-8` request went to deepseek). Fallback latency is ~23–35 s (Hermes startup + MCP boot + model); direct keyed calls are ~1–8 s.

## [0.2.3] — 2026-09-03

### Added
- **Lean direct-model panel.** The side panel now runs OpenSidekick's own agent loop (`agent.js` + `providers.js`) talking **straight to the model** — no `hermes chat` subprocess per message. End-to-end panel latency dropped from ~80 s to under ~18 s (cloud) by removing the Hermes spawn, its full MCP boot, and a fat agent prompt from the chat path.
- **Conversation persistence across Chrome close.** Chat moves from `chrome.storage.session` (clears when Chrome closes) to `chrome.storage.local`. Verified: the conversation survives panel close + reopen, and storage.local outlives a full Chrome restart by design. (This was the core "don't lose context like Claude for Chrome" requirement.)
- **Hermes provider port.** `bridge/relay.mjs` reads Hermes's active provider/model/key and pushes it to the extension over the WebSocket on connect; the extension stores it as a `hermes` provider and the lean loop uses it. Dedupe prevents a save → `storage.onChanged` → re-register loop.

### Changed
- `handleRunTask` → `getActiveProvider()` → `runAgent({…})` (direct path restored); scheduled tasks also use the lean loop.
- Dedicated `apollo` Hermes profile introduced for the earlier spawn-based path; later superseded by the default-profile follow (see 0.2.4).

### Fixed
- `GET_STATE` reflects real provider presence (`configured`), not a hardcoded `true`.

## [0.2.2] — 2026-09-03

### Changed
- **Hermes-only mode.** Removed the stock model/provider machinery from the run path — the panel routed every message to Hermes over the bridge. Killed the settings-bounce bug class (fresh unpacked installs had no Web-Store key and bounced to Settings on every submit).

### Fixed
- `refreshConfigured()` in the side panel asks the worker (`GET_STATE`) instead of reading local storage (which clobbered the Hermes-aware state).
- MV3 service-worker idle death: `startRelay()` runs at module top level on every worker spin-up, so the WebSocket reconnects after relay restarts without a Chrome restart.

## [0.2.1] — 2026-09-03

### Added
- **Side-panel chat routes to Hermes over the bridge.** The relay spawns a resumable `hermes chat` session (`--continue apollo-panel --create-if-missing`); replies stream back as deltas. The named Hermes session is the conversation record — resumable and searchable in Hermes.
- `chat` / `chat_new` / `chat_abort` relay message types; extension chat channel with 60 s timeout.

### Fixed
- `-Q` quiet mode added to the Hermes spawn so stdout carries only the reply (banners/session trailers were leaking into the panel); relay strips ANSI.

## [0.2.0] — 2026-09-03

### Added
- **Local bridge transport** (the architectural core of the fork): `bridge/ws-server.mjs` (zero-dependency RFC 6455 WebSocket server), `bridge/relay.mjs` (always-on daemon on `127.0.0.1:8765`, id-namespace translation, multiplexing), `bridge/mcp-server.mjs` (stdio MCP server Hermes spawns). e2e test suite (`bridge/test-relay.mjs`) — 6/6 pass without Chrome.
- **Browser-tools MCP surface**: the extension registers its tools (17, settings-filtered) with the relay; a Hermes session sees them as `mcp_apollo_*` and can drive the real logged-in browser (read page, click, type, navigate, screenshot) — something stock OpenSidekick cannot do.
- **Rebrand**: Apollo — Hermes-Driven Browser Agent; live green/red bridge badge on the toolbar icon; versioned 0.2.0.
- `hermes mcp add apollo …` registration; 17/17 tools live.

### Fixed
- Relay bring-up bugs found by the no-Chrome e2e: `_emitText` double-emit, control replies shaped as `res` (not `tools`), call-id namespace collision leaving callers hanging, extension-close detection comparing wrapper vs raw connection, unhandled socket errors on teardown.

## [0.1.7] — fork point

Branched from upstream [esterhuizen/opensidekick](https://github.com/esterhuizen/opensidekick) at `96fa52a` (v0.1.7). All 0.1.x history belongs to the upstream project — see below.

---

## Upstream (OpenSidekick) history

<details>
<summary>OpenSidekick changelog (pre-fork, © its contributors)</summary>

All notable changes to OpenSidekick are documented here. (Preserved verbatim from upstream for provenance.)

The project is intentionally simple: a single agent loop that can read and act on
the current page. Features are added only when the browser genuinely can't be
replaced by an API. As a result it has no vector store, no "memory", no
multi-agent orchestration — and therefore nothing to tune, cache-bust, or
optimize away.

### 0.1.7
— (upstream history as of the fork point; see the upstream repository for the
full changelog.)

</details>

## License

MIT. Apollo © 2026 Joe Bradford (fork additions). OpenSidekick © 2026 its contributors. See [LICENSE](LICENSE).
