import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "dist", "lite-server");
const target = join(root, "dist", "vibe-tree-lite");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => !path.endsWith(".map"),
});
writeFileSync(join(target, "package.json"), JSON.stringify({
  name: "vibe-tree-lite-runtime",
  private: true,
  version: "0.8.2-lite.1",
  type: "module",
  scripts: { start: "node lite/server.js" },
}, null, 2) + "\n");
writeFileSync(join(target, "README.txt"), [
  "Vibe Tree Lite 0.8.2-lite.1",
  "",
  "Requires Node.js 22 or newer. No npm install is required.",
  "Start: node lite/server.js",
  "Open:  http://127.0.0.1:47831",
  "",
  "Do not run this service and the Electron Vibe Tree app at the same time.",
  "The service reuses the standard Vibe Tree data directory and cloud identity.",
  "See LITE.md in the source repository for configuration and two-device setup.",
  "",
].join("\n"));

console.log(`Lite runtime packaged at ${target}`);
