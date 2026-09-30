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
/**
 * Default install keeps the dashboard resident, which is what the existing
 * LaunchAgent does. `--schedule` instead installs a non-resident pass: the job
 * wakes on login and then once per interval, scans, uploads and exits, so no
 * process is left polling session trees between runs.
 */
const scheduled = process.argv.includes("--schedule");
const intervalSeconds = scheduled ? numericArg("--interval", 3600, 60) : 0;

/**
 * launchd starts the job with no login shell, so the proxy variables a shell
 * profile exports are absent and every upload fails with "cannot reach the sync
 * service". Reading the macOS network proxy settings keeps the scheduled run
 * working without hardcoding a port: a user who changes proxy ports updates
 * System Settings, not this script.
 */
function systemProxyEnvironment() {
  const result = spawnSync("scutil", ["--proxy"], { encoding: "utf8" });
  const output = result.stdout ?? "";
  const read = (key) => {
    const match = output.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
    return match ? match[1] : undefined;
  };
  const enabled = read("HTTPSEnable") === "1" || read("HTTPEnable") === "1";
  const host = read("HTTPSProxy") ?? read("HTTPProxy");
  const port = read("HTTPSPort") ?? read("HTTPPort");
  if (!enabled || !host || !port) return [];
  const url = `http://${host}:${port}`;
  return [
    ["HTTPS_PROXY", url],
    ["HTTP_PROXY", url],
    ["NO_PROXY", "127.0.0.1,localhost,::1"],
  ];
}

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
// A resident install is kept alive; a scheduled install is launched by launchd
// once per interval and must not be restarted after it exits, which is why the
// two modes differ in KeepAlive/StartInterval rather than in the program.
const proxyEnvironment = systemProxyEnvironment();
const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(server)}</string>
${scheduled ? `    <string>--once</string>\n` : ""}  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_USE_ENV_PROXY</key><string>1</string>
${proxyEnvironment.map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>\n`).join("")}  </dict>
  <key>RunAtLoad</key><true/>
${scheduled
  ? `  <key>StartInterval</key><integer>${intervalSeconds}</integer>\n`
  : `  <key>KeepAlive</key><true/>\n`}  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logsDir, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDir, "service-error.log"))}</string>
</dict>
</plist>
`;

// `--print-plist` renders the exact LaunchAgent without touching launchd, so the
// scheduled variant can be inspected (and diffed) before it is installed.
if (process.argv.includes("--print-plist")) {
  console.log(plistBody);
  process.exit(0);
}

mkdirSync(agentsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
writeFileSync(plist, plistBody);

spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
run("launchctl", ["bootstrap", domain, plist]);
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
if (scheduled) {
  console.log(`Vibe Tree Lite scheduled: one scan-and-sync pass every ${intervalSeconds}s, then exit.`);
  console.log(`No dashboard server is running in this mode; run without --schedule to restore it.`);
} else {
  console.log(`Vibe Tree Lite installed. Open http://127.0.0.1:47831`);
}
console.log(`LaunchAgent: ${plist}`);
if (proxyEnvironment.length) {
  console.log(`Proxy from macOS network settings: ${proxyEnvironment[0][1]}`);
}

function numericArg(name, fallback, minimum) {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
}

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
