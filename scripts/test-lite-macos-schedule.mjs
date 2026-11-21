import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise actual installer output without calling launchd, system proxy tools,
// AppleScript, or changing the installed LaunchAgent/device settings.
if (process.platform !== "darwin") {
  console.log("macOS schedule checks skipped on this platform");
  process.exit(0);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, "lite-schedule-"));
const marker = join(temporary, "unexpected-system-mutation");
const settings = join(temporary, "device-settings.json");
const original = '{"launchOnStartup":true}\n';
writeFileSync(settings, original);
for (const command of ["ps", "scutil", "launchctl", "osascript"]) {
  const script = ["ps", "scutil"].includes(command)
    ? "#!/bin/sh\nexit 0\n"
    : '#!/bin/sh\nprintf unexpected > "$SCHEDULE_TEST_MARKER"\nexit 99\n';
  writeFileSync(join(temporary, command), script, { mode: 0o755 });
}
function render(args) {
  const result = spawnSync(process.execPath, [join(root, "scripts/install-lite-macos.mjs"), ...args, "--print-plist"], {
    encoding: "utf8",
    env: { ...process.env, PATH: temporary + ":" + process.env.PATH,
      VIBE_TREE_USER_DATA_DIR: temporary, SCHEDULE_TEST_MARKER: marker },
  });
  assert.equal(result.status, 0, "print-plist must succeed without mutations");
  const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8", input: result.stdout,
  });
  assert.equal(parsed.status, 0, "generated plist must be valid");
  assert.equal(readFileSync(settings, "utf8"), original, "preview must not disable Electron autostart");
  assert.equal(existsSync(marker), false, "preview must not call launchctl or AppleScript");
  return JSON.parse(parsed.stdout);
}
try {
  const calendar = render(["--schedule"]);
  assert.deepEqual(calendar.StartCalendarInterval, { Minute: 0 });
  assert.equal(calendar.RunAtLoad, false);
  assert.equal(calendar.StartInterval, undefined);
  assert.equal(calendar.KeepAlive, undefined);
  assert.ok(calendar.ProgramArguments.includes("--once"));

  const interval = render(["--schedule", "--interval", "1800"]);
  assert.equal(interval.StartInterval, 1800);
  assert.equal(interval.RunAtLoad, true);
  assert.equal(interval.StartCalendarInterval, undefined);
  assert.equal(interval.KeepAlive, undefined);
  assert.ok(interval.ProgramArguments.includes("--once"));

  const resident = render([]);
  assert.equal(resident.KeepAlive, true);
  assert.equal(resident.RunAtLoad, true);
  assert.equal(resident.StartInterval, undefined);
  assert.equal(resident.StartCalendarInterval, undefined);
  assert.ok(!resident.ProgramArguments.includes("--once"));
  console.log("macOS installer: hourly calendar, explicit interval, resident mode and read-only preview passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
