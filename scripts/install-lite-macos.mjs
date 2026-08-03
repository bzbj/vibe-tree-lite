import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("This installer is for macOS only.");

const label = "dev.opengrove.vibe-tree-lite";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "dist", "lite-server", "lite", "server.js");
const agentsDir = join(homedir(), "Library", "LaunchAgents");
const logsDir = join(homedir(), "Library", "Logs", "Vibe Tree Lite");
const plist = join(agentsDir, `${label}.plist`);
const domain = `gui/${process.getuid()}`;

const processList = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
const electronRunning = processList.stdout.split("\n").some((command) => (
  /^(?:\S*\/)?Vibe Tree\.app\/Contents\/MacOS\/Vibe Tree(?:\s|$)/.test(command.trim()) ||
  /^\S*Electron(?:\s+)\S*dist\/electron\/main\.js(?:\s|$)/.test(command.trim())
));
if (electronRunning) {
  throw new Error("Quit the Electron Vibe Tree app before installing Lite.");
}

disableElectronAutostart();

mkdirSync(agentsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(server)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_USE_ENV_PROXY</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logsDir, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDir, "service-error.log"))}</string>
</dict>
</plist>
`);

spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
run("launchctl", ["bootstrap", domain, plist]);
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
console.log(`Vibe Tree Lite installed. Open http://127.0.0.1:47831`);
console.log(`LaunchAgent: ${plist}`);

function disableElectronAutostart() {
  const dataDir = process.env.VIBE_TREE_USER_DATA_DIR?.trim() || join(homedir(), "Library", "Application Support", "Vibe Tree");
  const settingsPath = join(dataDir, "device-settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (settings.launchOnStartup !== false) {
      settings.launchOnStartup = false;
      const temporary = `${settingsPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      renameSync(temporary, settingsPath);
    }
  }
  spawnSync("osascript", [
    "-e",
    'tell application "System Events" to if exists login item "Vibe Tree" then delete login item "Vibe Tree"',
  ], { stdio: "ignore" });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
