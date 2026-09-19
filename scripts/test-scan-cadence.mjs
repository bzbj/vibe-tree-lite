import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  DEFAULT_SCAN_INTERVAL_MS,
  checkpointIntervalMs,
  resolveScanIntervalMs,
} from "../dist/lite-server/electron/scanCadence.js";
import { startDeepSeekSessionWatcher } from "../dist/lite-server/electron/deepseekSessionWatcher.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function frame(records) {
  return zstdCompressSync(Buffer.from(records.map(line).join(""), "utf8"));
}

function event(type, seq, time, data) {
  return { type, seq, time, data };
}

function usage(inputTokens, outputTokens) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const previousInterval = process.env.VIBE_TREE_LITE_SCAN_INTERVAL_MS;
const setIntervalEnv = (value) => {
  if (value === undefined) delete process.env.VIBE_TREE_LITE_SCAN_INTERVAL_MS;
  else process.env.VIBE_TREE_LITE_SCAN_INTERVAL_MS = value;
};

try {
  // --- Interval resolution -------------------------------------------------
  setIntervalEnv(undefined);
  assert(
    resolveScanIntervalMs() === DEFAULT_SCAN_INTERVAL_MS,
    "the default scan interval must preserve the historical cadence",
  );
  setIntervalEnv("3600000");
  assert(resolveScanIntervalMs() === 3_600_000, "an explicit interval must be honoured");
  setIntervalEnv(" 60000 ");
  assert(resolveScanIntervalMs() === 60_000, "surrounding whitespace must be tolerated");
  for (const bad of ["", "abc", "0", "-1", "999", "86400001", "NaN"]) {
    setIntervalEnv(bad);
    assert(
      resolveScanIntervalMs() === DEFAULT_SCAN_INTERVAL_MS,
      `an out-of-range interval (${JSON.stringify(bad)}) must fall back to the default`,
    );
  }

  // --- Checkpoint throttle -------------------------------------------------
  // The checkpoint window must stay inside the interval so a short cadence keeps
  // flushing often, and it must never exceed the interval itself.
  for (const interval of [1_000, 10_000, 60_000, 3_600_000, 86_400_000]) {
    const checkpoint = checkpointIntervalMs(interval);
    assert(checkpoint > 0, `checkpoint window must be positive for ${interval}`);
    assert(checkpoint <= interval, `checkpoint window must not exceed the interval for ${interval}`);
  }
  assert(
    checkpointIntervalMs(10_000) <= 10_000,
    "a ten-second interval must stay within its own cadence",
  );
  assert(
    checkpointIntervalMs(3_600_000) >= 30_000,
    "a long sweep must still checkpoint within a bounded window",
  );
  setIntervalEnv(undefined);

  // --- Idle sweeps must not touch the state file ---------------------------
  const root = mkdtempSync(join(tmpdir(), "vibe-tree-scan-idle-"));
  const sessionsRoot = join(root, "sessions");
  const userDataPath = join(root, "user-data");
  const sessionDir = join(sessionsRoot, "--fixture--");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(userDataPath, { recursive: true });
  const sessionPath = join(sessionDir, "session.v3.jsonl.zstd");
  const statePath = join(userDataPath, "deepseek-session-watcher.json");

  const now = Date.now();
  writeFileSync(
    sessionPath,
    frame([
      { type: "session", version: 3, id: "fixture-idle", createdAt: now, isSeeded: false },
      event("step/start", 0, now, { turn: 0, step: 0 }),
      event("assistant/chunk", 1, now, { turn: 0, step: 0, chunk: { type: "usage", usage: usage(100, 20) } }),
      event("assistant/message", 2, now, { turn: 0, step: 0, usage: usage(100, 20) }),
      event("step/end", 3, now, { turn: 0, step: 0 }),
    ]),
  );

  const events = [];
  const watcher = startDeepSeekSessionWatcher({
    userDataPath,
    sessionsRoot,
    historyStartAt: "2020-01-01T00:00:00.000Z",
    onUsage: (event) => events.push(event),
  });

  try {
    const imported = await watcher.scanNow();
    assert(imported === 1, `the first sweep must import the pending usage, got ${imported}`);
    const afterFirstScan = statSync(statePath).mtimeMs;

    // An idle sweep must be a pure read: no import and no state rewrite.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const idleImported = await watcher.scanNow();
      assert(idleImported === 0, `an idle sweep must import nothing, got ${idleImported}`);
    }
    assert(
      statSync(statePath).mtimeMs === afterFirstScan,
      "an idle sweep must not rewrite the watcher state file",
    );

    // New usage must still be picked up and persisted.
    appendFileSync(
      sessionPath,
      frame([
        event("step/start", 4, now + 1000, { turn: 1, step: 0 }),
        event("assistant/message", 5, now + 1000, { turn: 1, step: 0, usage: usage(300, 60) }),
        event("step/end", 6, now + 1000, { turn: 1, step: 0 }),
      ]),
    );
    const activeImported = await watcher.scanNow();
    assert(activeImported === 1, `new usage must still be imported, got ${activeImported}`);
    assert(
      statSync(statePath).mtimeMs > afterFirstScan,
      "a sweep that advances progress must persist the state file",
    );
    assert(events.length === 2, `both sweeps together must emit two events, got ${events.length}`);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }

  console.log("scan cadence and idle-write tests passed");
} finally {
  setIntervalEnv(previousInterval);
}
