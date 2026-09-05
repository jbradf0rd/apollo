// In-memory holder for the Hermes-ported API key.
//
// The README promise is literal: no API key is ever STORED in the browser.
// The relay supplies the key on every connection, the service worker keeps it
// here (module memory only, never chrome.storage), and getActiveProvider()
// attaches it for the direct-model call path. When MV3 kills the worker the
// memory dies with it — and every spin-up re-connects and re-ports, so the
// key is always fresh before the panel can use it.

let key = "";

export function setHermesKey(k) {
  key = typeof k === "string" ? k : "";
}

export function getHermesKey() {
  return key;
}
