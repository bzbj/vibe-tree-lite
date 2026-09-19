import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server did not become ready: ${output}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("VIBE_TREE_LITE_READY")) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}: ${output}`));
    });
  });
}

const fixture = mkdtempSync(join(tmpdir(), "vibe-tree-scan-api-"));
const serverPath = fileURLToPath(new URL("../dist/lite-server/lite/server.js", import.meta.url));
let child;

try {
  const sessionsRoot = join(fixture, "codex-sessions");
  const day = new Date().toISOString().slice(0, 10);
  const sessionPath = join(sessionsRoot, ...day.split("-"), "rollout-scan-api.jsonl");
  const now = new Date().toISOString();
  writeJsonl(sessionPath, [meta(now, { cwd: fixture }), tokenLine(now, 1234)]);

  mkdirSync(fixture, { recursive: true });
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

  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VIBE_TREE_USER_DATA_DIR: fixture,
      VIBE_TREE_LITE_PORT: "0",
      VIBE_TREE_LITE_DISABLE_SYNC: "1",
      // A long cadence proves the fixture does not depend on a scheduled sweep,
      // which is exactly the situation the on-demand action exists for.
      VIBE_TREE_LITE_SCAN_INTERVAL_MS: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = await waitForReady(child);
  const base = output.match(/VIBE_TREE_LITE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(base, "server should print a ready URL");

  const html = await fetch(base).then((response) => response.text());
  const token = html.match(/meta name="vibe-tree-token" content="([^"]+)"/)?.[1];
  assert(token, "the page should expose a CSRF token");

  // The button the page wires this to must exist.
  assert(html.includes('id="scan-button"'), "the dashboard should render a scan button");
  const app = await fetch(`${base}/app.js`).then((response) => response.text());
  assert(app.includes('"/api/scan"'), "the dashboard script should call the scan endpoint");

  const eventsPath = join(fixture, "usage-events.jsonl");
  const ledgers = () => (existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean) : []);

  // CSRF: the endpoint is a mutation and must reject a request without the token.
  const rejected = await fetch(`${base}/api/scan`, { method: "POST" });
  assert(rejected.status === 403, `scan without a CSRF token should be rejected, got ${rejected.status}`);

  // Codex reports cumulative usage, so the first observed count only seeds the
  // baseline. The first sweep must record it without emitting an event.
  const seeded = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token },
  }).then((response) => response.json());
  assert(!seeded.error, `the first scan should succeed, got ${JSON.stringify(seeded)}`);
  assert(seeded.scanned >= 1, `the scan should report at least one watcher, got ${seeded.scanned}`);
  const baseline = ledgers();
  assert(
    baseline.length === 0,
    `the baseline sweep must not spend tokens it cannot measure yet, got ${JSON.stringify(baseline)}`,
  );

  // Growth in the cumulative counter is what produces a deltas event.
  appendJsonl(sessionPath, [tokenLine(new Date().toISOString(), 1234 + 1000)]);
  const second = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token },
  }).then((response) => response.json());
  assert(!second.error, `the second scan should succeed, got ${JSON.stringify(second)}`);
  const afterGrowth = ledgers();
  assert(
    afterGrowth.some((line) => line.includes("codex-session")),
    `an on-demand sweep should import usage growth, got ${JSON.stringify(afterGrowth)}`,
  );

  // A repeat sweep must not duplicate the same usage.
  const third = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token },
  }).then((response) => response.json());
  assert(!third.error, "a repeat scan should succeed");
  assert(
    ledgers().length === afterGrowth.length,
    `a repeat sweep must not import the same usage twice (${afterGrowth.length} -> ${ledgers().length})`,
  );

  // Further growth must be picked up by a later sweep.
  appendJsonl(sessionPath, [tokenLine(new Date().toISOString(), 1234 + 1000 + 500)]);
  const fourth = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token },
  }).then((response) => response.json());
  assert(!fourth.error, "the follow-up scan should succeed");
  assert(
    ledgers().length > afterGrowth.length,
    `new usage must be imported on the next sweep (${afterGrowth.length} -> ${ledgers().length})`,
  );

  // The dashboard must reflect what the sweep imported.
  const dashboard = await fetch(`${base}/api/dashboard?days=30`).then((response) => response.json());
  assert(dashboard.totals.all > 0, "the dashboard should report the imported usage");

  // An idle sweep must leave the watcher state file untouched.
  const statePath = join(fixture, "codex-session-watcher.json");
  const idleBefore = statSync(statePath).mtimeMs;
  await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token },
  }).then((response) => response.json());
  assert(
    statSync(statePath).mtimeMs === idleBefore,
    "an idle on-demand sweep must not rewrite the watcher state file",
  );

  // Overlapping requests must all settle. A single-slot waiter would leave the
  // earlier callers pending forever once a newer request replaced the slot.
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { Origin: base, "X-Vibe-Tree-Token": token },
      }).then((response) => response.json()),
    ),
  );
  for (const result of concurrent) {
    assert(!result.error, `each overlapping scan should settle, got ${JSON.stringify(result)}`);
    assert(result.scanned >= 1, "each overlapping scan should report a sweep");
  }

  console.log("scan endpoint tests passed");
} finally {
  if (child) {
    child.kill();
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 5_000);
    });
  }
  rmSync(fixture, { recursive: true, force: true });
}

