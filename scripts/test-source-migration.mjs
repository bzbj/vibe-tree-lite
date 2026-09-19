import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

/** A settings file stamped with the version that introduced the broken guard. */
function legacySettings(overrides = {}) {
  return {
    treeStartMode: "new",
    enabledSourceIds: ["codex", "cloud"],
    sourceCatalogVersion: 2,
    leaderboardEnabled: false,
    cloudSyncEnabled: false,
    ...overrides,
  };
}

function writeFixture(fixture, settings) {
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "usage-meta.json"),
    JSON.stringify({ installedAt: new Date(Date.now() - 86_400_000).toISOString() }),
  );
  writeFileSync(join(fixture, "device-settings.json"), JSON.stringify(settings));
}

const serverPath = fileURLToPath(new URL("../dist/lite-server/lite/server.js", import.meta.url));
const storeUrl = pathToFileURL(fileURLToPath(new URL("../dist/lite-server/lite/store.js", import.meta.url))).href;
const { LiteStore } = await import(storeUrl);

// --- Migration of a stored list that predates the DeepSeek source -----------
// Version 2 shipped the DeepSeek source together with a `previousCatalogVersion
// < 2` guard, so no file stamped 2 could ever satisfy it. A file that reaches
// this code already says 2, which is why the migration never ran.
const migratedFixture = mkdtempSync(join(tmpdir(), "vibe-tree-migration-"));
try {
  writeFixture(migratedFixture, legacySettings());
  const migrated = new LiteStore(migratedFixture);
  const sources = migrated.ledger.settings.enabledSourceIds;
  assert(
    sources.includes("deepseek"),
    `a version 2 list must gain the DeepSeek source, got ${JSON.stringify(sources)}`,
  );
  assert(
    sources.indexOf("deepseek") < sources.indexOf("cloud"),
    `the migrated source should sit beside the others and before cloud, got ${JSON.stringify(sources)}`,
  );
  for (const source of ["codex", "cloud"]) {
    assert(sources.includes(source), `the migration must keep the existing "${source}" source`);
  }
  assert(
    migrated.ledger.settings.sourceCatalogVersion === 3,
    `the stored version should be recorded as current, got ${migrated.ledger.settings.sourceCatalogVersion}`,
  );
} finally {
  rmSync(migratedFixture, { recursive: true, force: true });
}

// --- A device that already migrated must not be disturbed ------------------
// Once the stored version is current, a deliberate choice must win: a device
// stamped 3 that does not list DeepSeek is a device whose owner turned it off,
// and re-enabling it would be wrong.
const currentFixture = mkdtempSync(join(tmpdir(), "vibe-tree-migration-current-"));
try {
  writeFixture(
    currentFixture,
    legacySettings({ enabledSourceIds: ["codex", "gemini", "cloud"], sourceCatalogVersion: 3 }),
  );
  const current = new LiteStore(currentFixture);
  const sources = current.ledger.settings.enabledSourceIds;
  assert(
    !sources.includes("deepseek"),
    `a deliberate choice recorded at the current version must be respected, got ${JSON.stringify(sources)}`,
  );
  assert(
    sources.includes("gemini"),
    `an unrelated enabled source must be preserved, got ${JSON.stringify(sources)}`,
  );
} finally {
  rmSync(currentFixture, { recursive: true, force: true });
}

// A version 2 file that already lists DeepSeek must keep it exactly once.
const alreadyListedFixture = mkdtempSync(join(tmpdir(), "vibe-tree-migration-listed-"));
try {
  writeFixture(
    alreadyListedFixture,
    legacySettings({ enabledSourceIds: ["codex", "deepseek", "cloud"], sourceCatalogVersion: 2 }),
  );
  const alreadyListed = new LiteStore(alreadyListedFixture);
  const sources = alreadyListed.ledger.settings.enabledSourceIds;
  assert(
    sources.filter((source) => source === "deepseek").length === 1,
    `the migration must not duplicate an already-listed source, got ${JSON.stringify(sources)}`,
  );
} finally {
  rmSync(alreadyListedFixture, { recursive: true, force: true });
}

// --- The migrated list must actually start the DeepSeek watcher -------------
const fixture = mkdtempSync(join(tmpdir(), "vibe-tree-migration-server-"));
let child;
try {
  writeFixture(fixture, legacySettings());
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VIBE_TREE_USER_DATA_DIR: fixture,
      VIBE_TREE_LITE_PORT: "0",
      VIBE_TREE_LITE_DISABLE_SYNC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = await waitForReady(child);
  const base = output.match(/VIBE_TREE_LITE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(base, "server should print a ready URL");

  // A watcher reports itself running on its first status publish, but the
  // Codex watcher claims its status only after walking its session tree, so
  // poll rather than sampling once. `cloud` is a sync source, not a watcher,
  // so an upgraded device with codex + deepseek + cloud yields two watchers.
  let running = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dashboard = await fetch(`${base}/api/dashboard?days=30`).then((response) => response.json());
    running = dashboard.watchers.running;
    if (running >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(
    running >= 2,
    `the migrated DeepSeek source must be watched, got ${running} running watchers (expected codex + deepseek)`,
  );

  console.log("deepseek source migration tests passed");
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
