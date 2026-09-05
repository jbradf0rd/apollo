// Syntax-check every committed JS/MJS file with `node --check`.
// Cross-platform (the old bash `for f in $(...)` broke under cmd.exe on Windows).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "*.js", "*.mjs"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((f) => existsSync(f)); // deleted-but-uncommitted files would fail otherwise

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch {
    console.error("SYNTAX FAIL:", f);
    failed++;
  }
}
if (failed) {
  console.error(`${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`all ${files.length} JS/MJS files OK`);
