// Tjekker, at serverkoden og temaets JavaScript kan læses af Node, før der
// udgives. Fanger stavefejl i koden; ikke logik.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mapper = ["base44-app/src/lib", "base44-app/src/routes/api", "extensions/erhverv-tema/assets"];
const tmp = mkdtempSync(join(tmpdir(), "tjek-"));
let fejl = 0;
for (const m of mapper) {
  for (const f of readdirSync(m).filter((x) => x.endsWith(".js"))) {
    const kopi = join(tmp, "x.mjs");
    copyFileSync(join(m, f), kopi);
    try {
      execFileSync(process.execPath, ["--check", kopi], { stdio: "pipe" });
    } catch (e) {
      fejl++;
      console.error(`✗ ${m}/${f}\n${e.stderr}`);
    }
  }
}
console.log(fejl ? `${fejl} fil(er) med fejl` : "✓ Al JavaScript kan læses");
process.exit(fejl ? 1 : 0);
