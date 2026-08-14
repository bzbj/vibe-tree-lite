import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicSource = join(root, "src", "lite", "public");
const publicTarget = join(root, "dist", "lite-server", "lite", "public");
const themesSource = join(root, "src", "lite", "themes");
const themesTarget = join(root, "dist", "lite-server", "lite", "themes");

for (const target of [publicTarget, themesTarget]) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}
cpSync(publicSource, publicTarget, { recursive: true, force: true });
cpSync(themesSource, themesTarget, { recursive: true, force: true });
