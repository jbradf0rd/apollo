// Probe: exercises the exact readHermesProvider logic from relay.mjs.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = process.env.HERMES_HOME || path.join(os.homedir(), "AppData", "Local", "hermes");
const profile = process.env.APOLLO_HERMES_PROFILE || "apollo";
const cfg = readFileSync(path.join(home, "profiles", profile, "config.yaml"), "utf8").replace(/\r/g, "");
const block = (cfg.match(/^model:[ \t]*\n((?:[ \t]+.*\n?)*)/m) || [])[1] || "";
const grab = (k) => {
  const m = block.match(new RegExp("^ {2}" + k + ":[ \\t]*([^\\n]+)", "m"));
  return m ? m[1].trim() : "";
};
const provider = grab("provider") || "deepseek";
const model = grab("default") || "";
const readEnv = (dir) => { try { return readFileSync(path.join(dir, ".env"), "utf8"); } catch { return ""; } };
const envText = readEnv(path.join(home, "profiles", profile)).replace(/\r/g, "") + "\n" + readEnv(home).replace(/\r/g, "");
const getEnv = (k) => { const m = envText.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim() : ""; };
let baseUrl = "", apiKey = "";
if (provider === "deepseek") { baseUrl = getEnv("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1"; apiKey = getEnv("DEEPSEEK_API_KEY"); }
else if (provider === "custom") { baseUrl = grab("base_url"); apiKey = grab("api_key") || "local"; }
console.log(JSON.stringify({ provider, model, baseUrl, apiKeyPresent: !!apiKey, apiKeyLen: apiKey.length }, null, 2));
