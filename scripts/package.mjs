// Build apollo.zip (manifest + src + icons + LICENSE) — cross-platform.
// Windows: PowerShell Compress-Archive. macOS/Linux: `zip -r` (zip is usually
// present; apt install zip / brew install zip if not).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(REPO, "apollo.zip");

if (existsSync(OUT)) rmSync(OUT);

if (process.platform === "win32") {
  const items = ["manifest.json", "src", "icons", "LICENSE"];
  const args = ["-NoProfile", "-Command",
    `Compress-Archive -Path ${items.join(",")} -DestinationPath apollo.zip -Force`];
  const r = spawnSync("powershell", args, { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("zip failed");
    process.exit(r.status ?? 1);
  }
} else {
  const r = spawnSync("zip", ["-r", "apollo.zip", "manifest.json", "src", "icons", "LICENSE", "-x", "*.DS_Store"], {
    cwd: REPO, stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("zip failed (is `zip` installed?)");
    process.exit(r.status ?? 1);
  }
}
console.log("wrote apollo.zip");
