import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "vibe-tree-lite-test-"));
const port = 49000 + (process.pid % 999);
const serverPath = fileURLToPath(new URL("../dist/lite-server/lite/server.js", import.meta.url));

try {
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "usage-meta.json"), JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  writeFileSync(join(fixture, "device-settings.json"), JSON.stringify({
    treeStartMode: "new",
    enabledSourceIds: ["codex", "cloud"],
    leaderboardEnabled: false,
    cloudSyncEnabled: false,
  }));
  const now = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  writeFileSync(join(fixture, "usage-events.jsonl"), [
    event("one", yesterday, "gpt-5.6", 1200),
    event("two", now, "gpt-5.6", 2000),
    event("three", now, "o4-mini", 500),
  ].map(JSON.stringify).join("\n") + "\n");

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VIBE_TREE_USER_DATA_DIR: fixture,
      VIBE_TREE_LITE_PORT: String(port),
      VIBE_TREE_LITE_DISABLE_SYNC: "1",
      VIBE_TREE_LITE_DISABLE_WATCHERS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await waitForReady(child);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  const dashboard = await fetch(`${base}/api/dashboard?days=30`).then((response) => response.json());
  const html = await fetch(base).then((response) => response.text());
  const token = html.match(/meta name="vibe-tree-token" content="([^"]+)"/)?.[1];
  const disabledSync = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token ?? "" },
  }).then((response) => response.json());

  assert(health.ok === true, "health endpoint");
  assert(dashboard.totals.today === 2500, "today total");
  assert(dashboard.topModel === "gpt-5.6", "top model");
  assert(dashboard.chart.at(-1).models["o4-mini"] === 500, "per-model chart");
  assert(html.includes("Vibe Tree Lite") && !html.includes("__VIBE_TREE_CSRF_TOKEN__"), "dashboard HTML and CSRF injection");
  assert(html.includes('id="rank-list"') && html.includes('id="auth-actions"'), "leaderboard and GitHub sync controls");
  assert(disabledSync.error === "当前以禁用同步模式运行。", "disabled sync returns a bounded API error");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  if (process.platform !== "win32") {
    assert(!existsSync(join(fixture, "runtime-lite.lock")), "runtime lock cleanup");
  }
  console.log(`Lite smoke test passed (${output.trim()})`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function event(id, createdAt, model, tokens) {
  return {
    id, createdAt: createdAt.toISOString(), source: "codex-session", tokens,
    agent: "codex-desktop", provider: "openai", model, inputTokens: tokens, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`server timeout\n${stderr}`)), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("VIBE_TREE_LITE_READY")) { clearTimeout(timer); resolve(stdout); }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => { if (!stdout.includes("VIBE_TREE_LITE_READY")) reject(new Error(`server exited ${code}\n${stderr}`)); });
  });
}

function assert(value, label) {
  if (!value) throw new Error(`Assertion failed: ${label}`);
}
