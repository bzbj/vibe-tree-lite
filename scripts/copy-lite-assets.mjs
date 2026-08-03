import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src", "lite", "public");
const target = join(root, "dist", "lite-server", "lite", "public");

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, force: true });
