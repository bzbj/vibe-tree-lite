import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Verifies the scheduled `--once` pass: one sweep plus one upload, then exit.
 *
 * The fixture disables sync so the run exercises the collector lifecycle that
 * makes a non-resident schedule safe: the watcher must persist its read
 * position before the process exits, and a later run must import only what the
 * session file appended in between instead of rereading the whole tree.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJsonl(filePath, lines) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

function appendJsonl(filePath, lines) {
  appendFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

function meta(timestamp, payload = {}) {
  return { timestamp, type: "session_meta", payload };
}

function tokenLine(timestamp, total) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
        total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
      },
    },
  };
}

/** Runs one scheduled pass and resolves with its exit code plus captured output. */
function runOnce(serverPath, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, "--once"], {
      env: {
        ...process.env,
        VIBE_TREE_USER_DATA_DIR: fixture,
        VIBE_TREE_LITE_DISABLE_SYNC: "1",
        VIBE_TREE_LITE_SCAN_INTERVAL_MS: "3600000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`one-shot run did not exit within 60s: ${output}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

function doneReport(output) {
  const match = output.match(/VIBE_TREE_LITE_ONCE_DONE (\{.*\})/);
  assert(match, `the run should print a completion report, got: ${output}`);
  return JSON.parse(match[1]);
}

const fixture = mkdtempSync(join(tmpdir(), "vibe-tree-once-"));
const serverPath = fileURLToPath(new URL("../dist/lite-server/lite/server.js", import.meta.url));

try {
  const sessionsRoot = join(fixture, "codex-sessions");
  const day = new Date().toISOString().slice(0, 10);
  const sessionPath = join(sessionsRoot, ...day.split("-"), "rollout-once.jsonl");
  const now = new Date().toISOString();
  writeJsonl(sessionPath, [meta(now, { cwd: fixture }), tokenLine(now, 1_234)]);

  writeFileSync(
    join(fixture, "usage-meta.json"),
    JSON.stringify({ installedAt: new Date(Date.now() - 86_400_000).toISOString() }),
  );
  writeFileSync(
    join(fixture, "device-settings.json"),
    JSON.stringify({
      treeStartMode: "new",
      enabledSourceIds: ["codex", "cloud"],
      codexSessionsDir: sessionsRoot,
      leaderboardEnabled: false,
      cloudSyncEnabled: false,
    }),
  );

  const eventsPath = join(fixture, "usage-events.jsonl");
  const ledger = () => (existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean) : []);
  const watcherStatePath = join(fixture, "codex-session-watcher.json");

  // 1. A scheduled pass seeds the cumulative baseline and exits on its own.
  const first = await runOnce(serverPath, fixture);
  assert(first.signal === null, `the first pass should exit by itself, got signal ${first.signal}`);
  assert(first.code === 0, `the first pass should succeed, got code ${first.code}: ${first.output}`);
  assert(
    !first.output.includes("VIBE_TREE_LITE_READY"),
    "a scheduled pass must not start the dashboard server",
  );
  const firstReport = doneReport(first.output);
  assert(firstReport.scanned >= 1, `the pass should sweep at least one watcher, got ${JSON.stringify(firstReport)}`);
  assert(
    ledger().length === 0,
    `seeding a cumulative baseline must not spend tokens, got ${JSON.stringify(ledger())}`,
  );
  assert(existsSync(watcherStatePath), "the pass must persist the watcher read position before exiting");

  // 2. A second pass with no new session lines must stay quiet: no new events,
  //    and no work invented just because the process restarted.
  const idle = await runOnce(serverPath, fixture);
  assert(idle.code === 0, `an idle pass should succeed, got code ${idle.code}: ${idle.output}`);
  assert(ledger().length === 0, `an idle pass must not import anything, got ${JSON.stringify(ledger())}`);

  // 3. Growth between passes is imported as a single delta, which is the whole
  //    point of keeping per-file offsets in the watcher state.
  appendJsonl(sessionPath, [tokenLine(new Date().toISOString(), 1_234 + 1_000)]);
  const grown = await runOnce(serverPath, fixture);
  assert(grown.code === 0, `the pass after growth should succeed: ${grown.output}`);
  const entries = ledger();
  assert(entries.length === 1, `growth should import exactly one event, got ${entries.length}`);
  const entry = JSON.parse(entries[0]);
  assert(entry.tokens === 1_000, `the event should carry the 1000-token delta, got ${entry.tokens}`);

  // 4. Replaying must be idempotent: the offset already covers the appended line.
  const replay = await runOnce(serverPath, fixture);
  assert(replay.code === 0, `the replay pass should succeed: ${replay.output}`);
  assert(ledger().length === 1, `a replayed pass must not duplicate the delta, got ${ledger().length}`);

  console.log("one-shot job: all assertions passed");
  console.log(`  pass reports: ${JSON.stringify([first, idle, grown, replay].map((run) => doneReport(run.output)))}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
