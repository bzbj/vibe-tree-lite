import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("This uninstaller is for macOS only.");

const label = "dev.opengrove.vibe-tree-lite";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;

spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
rmSync(plist, { force: true });
console.log("Vibe Tree Lite LaunchAgent removed. Token history and cloud identity were kept.");
