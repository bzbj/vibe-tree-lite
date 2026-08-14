import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "vibe-tree-lite-test-"));
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
  const themesRoot = join(fixture, "themes");
  writeThemePack(themesRoot, "quiet-test", {
    name: "安静测试",
    subtitle: "Quiet Test",
    css: testThemeCss("quiet-test-loaded"),
  });
  writeThemePack(themesRoot, "mascot-test", {
    schemaVersion: 2,
    name: "橘猫测试",
    subtitle: "Mascot Test",
    css: testThemeCss("mascot-test-loaded"),
    mascot: true,
    motion: "static",
  });
  writeThemePack(themesRoot, "invalid-entry", {
    name: "错误入口",
    subtitle: "Invalid Entry",
    entry: "../theme.css",
    css: testThemeCss("must-not-load"),
  });
  writeThemePack(themesRoot, "remote-import", {
    name: "远程导入",
    subtitle: "Remote Import",
    css: `@import url("https://example.com/theme.css");\n${testThemeCss("must-not-load")}`,
  });
  writeThemePack(themesRoot, "remote-image", {
    name: "远程图片",
    subtitle: "Remote Image",
    css: testThemeCss("must-not-load").replace("linear-gradient(#10131a, #171b24)", 'image-set("https://example.com/background.png" 1x)'),
  });
  writeThemePack(themesRoot, "obfuscated-url", {
    name: "混淆链接",
    subtitle: "Obfuscated URL",
    css: testThemeCss("must-not-load").replace("linear-gradient(#10131a, #171b24)", "u/**/rl(https://example.com/background.png)"),
  });
  writeThemePack(themesRoot, "mascot-missing", {
    schemaVersion: 2,
    name: "缺失猫图",
    subtitle: "Missing Mascot",
    css: testThemeCss("must-not-load"),
    mascot: { asset: "assets/missing.png" },
  });

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VIBE_TREE_USER_DATA_DIR: fixture,
      VIBE_TREE_LITE_PORT: "0",
      VIBE_TREE_LITE_DISABLE_SYNC: "1",
      VIBE_TREE_LITE_DISABLE_WATCHERS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await waitForReady(child);
  const base = output.match(/VIBE_TREE_LITE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(base, "ready URL");
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  const dashboard = await fetch(`${base}/api/dashboard?days=30`).then((response) => response.json());
  const html = await fetch(base).then((response) => response.text());
  const css = await fetch(`${base}/styles.css`).then((response) => response.text());
  const app = await fetch(`${base}/app.js`).then((response) => response.text());
  const themes = await fetch(`${base}/api/themes`).then((response) => response.json());
  const defaultThemeResponse = await fetch(`${base}/theme.css`);
  const defaultThemeCss = await defaultThemeResponse.text();
  const defaultMascotResponse = await fetch(`${base}/theme-mascot`);
  const token = html.match(/meta name="vibe-tree-token" content="([^"]+)"/)?.[1];
  const disabledSync = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token ?? "" },
  }).then((response) => response.json());
  const disabledGithubConnect = await fetch(`${base}/api/connect-github`, {
    method: "POST",
    headers: { Origin: base, "X-Vibe-Tree-Token": token ?? "" },
  }).then((response) => response.json());
  const unauthorizedThemeSelect = await fetch(`${base}/api/theme`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "quiet-test" }),
  });
  const missingThemeSelect = await fetch(`${base}/api/theme`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Vibe-Tree-Token": token ?? "" },
    body: JSON.stringify({ id: "missing-theme" }),
  });
  const malformedThemeSelect = await fetch(`${base}/api/theme`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Vibe-Tree-Token": token ?? "" },
    body: "{",
  });
  const oversizedThemeSelect = await fetch(`${base}/api/theme`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Vibe-Tree-Token": token ?? "" },
    body: JSON.stringify({ id: "quiet-test", padding: "x".repeat(4096) }),
  });
  const selectedTheme = await fetch(`${base}/api/theme`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", "X-Vibe-Tree-Token": token ?? "" },
    body: JSON.stringify({ id: "mascot-test" }),
  }).then((response) => response.json());
  const selectedThemeResponse = await fetch(`${base}/theme.css`);
  const selectedThemeCss = await selectedThemeResponse.text();
  const selectedMascotResponse = await fetch(`${base}/theme-mascot`);
  const selectedMascotBytes = await selectedMascotResponse.arrayBuffer();

  assert(health.ok === true, "health endpoint");
  assert(dashboard.totals.today === 2500, "today total");
  assert(dashboard.topModel === "gpt-5.6", "top model");
  assert(dashboard.chart.at(-1).models["o4-mini"] === 500, "per-model chart");
  assert(html.includes("Vibe Tree Lite · 阳光积木") && html.includes("Sunlit Blocks") && !html.includes("__VIBE_TREE_CSRF_TOKEN__"), "Sunlit Blocks dashboard branding and CSRF injection");
  assert(html.includes('id="theme-button"') && html.includes('id="theme-popover"') && html.includes('id="theme-select"') && html.includes('href="/theme.css"') && !html.includes("Prism Orbit") && !html.includes("流光星环"), "compact theme menu and stylesheet without Prism Orbit");
  assert(
    html.includes('href="https://github.com/bzbj/vibe-tree-lite"') &&
    html.includes('href="https://github.com/Olorinm/vibe-tree"') &&
    html.includes("© 2026") &&
    !html.includes("仅监听 127.0.0.1"),
    "footer copyright and repository attribution links",
  );
  assert(!html.includes('id="rank-list"') && !html.includes("LEADERBOARD") && html.includes('data-action="connect-github"'), "single GitHub connection control without leaderboard");
  assert(app.includes("GitHub · ${username}"), "GitHub username in the top sync state");
  assert(app.includes('mutate("/api/connect-github"'), "GitHub connection action");
  assert(app.includes('fetch("/api/themes"') && app.includes('fetch("/api/theme"') && app.includes("renderThemeOptions") && app.includes("handleThemeMenuKeydown"), "theme catalog and popover selection actions");
  assert(app.includes("setMascotState") && app.includes("/theme-mascot"), "declarative mascot runtime and asset route");
  assert(css.includes(".mascot-rail") && css.includes("prefers-reduced-motion"), "mascot rail and reduced-motion fallback");
  assert(css.includes(".bar-segment:active") && css.includes("transform: scale(0.97)") && !css.includes("dopamine-pop") && !app.includes("is-popping"), "restrained tile click feedback assets");
  assert(css.includes("Primitive fallbacks") && css.includes("Semantic fallbacks") && css.includes("Component fallbacks"), "three-layer theme token surface");
  assert(themes.activeId === "sunlit-blocks" && themes.themes.length === 3, "bundled, CSS-only, and mascot themes are discovered");
  assert(themes.themes.some((theme) => theme.id === "mascot-test" && theme.mascot?.slot === "chart-rail" && theme.mascot.motion === "static"), "mascot metadata is public without asset paths");
  assert(themes.ignoredCount === 5 && !JSON.stringify(themes).includes(fixture) && !JSON.stringify(themes).includes("theme.css") && !JSON.stringify(themes).includes("assets/"), "invalid packs are ignored without exposing paths or entries");
  assert(defaultThemeResponse.headers.get("x-vibe-tree-theme") === "sunlit-blocks" && defaultThemeCss.includes("--vt-p-cream-100"), "default bundled theme stylesheet");
  assert(defaultMascotResponse.status === 404, "themes without mascots do not expose a mascot asset");
  assert(unauthorizedThemeSelect.status === 403, "theme selection requires the page token");
  assert(missingThemeSelect.status === 404, "missing themes fail without changing state");
  assert(malformedThemeSelect.status === 400 && oversizedThemeSelect.status === 400, "malformed and oversized theme requests are bounded");
  assert(selectedTheme.ok === true && selectedTheme.activeId === "mascot-test" && selectedTheme.active.mascot?.slot === "chart-rail", "valid mascot theme selection");
  assert(selectedThemeResponse.headers.get("x-vibe-tree-theme") === "mascot-test" && selectedThemeCss.includes("mascot-test-loaded"), "selected mascot theme stylesheet");
  assert(selectedMascotResponse.status === 200 && selectedMascotResponse.headers.get("content-type")?.startsWith("image/png") && selectedMascotResponse.headers.get("x-vibe-tree-theme") === "mascot-test" && selectedMascotBytes.byteLength > 32, "selected mascot asset route");
  assert(JSON.parse(readFileSync(join(fixture, "lite-theme.json"), "utf8")).activeThemeId === "mascot-test", "theme selection persistence file");
  assert(disabledSync.error === "当前以禁用同步模式运行。", "disabled sync returns a bounded API error");
  assert(disabledGithubConnect.error === "当前以禁用同步模式运行。", "disabled GitHub connect returns a bounded API error");
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  if (process.platform !== "win32") {
    assert(!existsSync(join(fixture, "runtime-lite.lock")), "runtime lock cleanup");
  }

  const deepseekSessionsRoot = join(fixture, "deepseek-sessions");
  const deepseekFixtureDir = join(deepseekSessionsRoot, "--lite-fixture--");
  mkdirSync(deepseekFixtureDir, { recursive: true });
  writeFileSync(join(deepseekFixtureDir, "session.jsonl"), deepseekSessionLog(Date.now()), "utf8");
  writeFileSync(join(fixture, "device-settings.json"), JSON.stringify({
    treeStartMode: "new",
    enabledSourceIds: ["deepseek", "cloud"],
    sourceCatalogVersion: 2,
    leaderboardEnabled: false,
    cloudSyncEnabled: false,
  }));

  const deepseekChild = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VIBE_TREE_USER_DATA_DIR: fixture,
      VIBE_TREE_LITE_PORT: "0",
      VIBE_TREE_LITE_DISABLE_SYNC: "1",
      VIBE_DEEPSEEK_SESSIONS_DIR: deepseekSessionsRoot,
      VIBE_DEEPSEEK_IMPORT_HISTORY: "today",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deepseekOutput = await waitForReady(deepseekChild);
  const deepseekBase = deepseekOutput.match(/VIBE_TREE_LITE_READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(deepseekBase, "DeepSeek Lite ready URL");
  const restartedThemes = await fetch(`${deepseekBase}/api/themes`).then((response) => response.json());
  const restartedThemeResponse = await fetch(`${deepseekBase}/theme.css`);
  assert(restartedThemes.activeId === "mascot-test", "selected theme persists across Lite restart");
  assert(restartedThemeResponse.headers.get("x-vibe-tree-theme") === "mascot-test", "restart serves the persisted theme");
  const restartedMascotResponse = await fetch(`${deepseekBase}/theme-mascot`);
  assert(restartedMascotResponse.status === 200 && restartedMascotResponse.headers.get("x-vibe-tree-theme") === "mascot-test", "restart serves the persisted mascot");
  const deepseekDashboard = await waitForDashboard(deepseekBase, (value) => value.watchers?.eventsImported === 1);
  assert(deepseekDashboard.watchers.running === 1, "only the enabled DeepSeek watcher is running");
  assert(deepseekDashboard.watchers.detected === 1, "DeepSeek sessions root is detected");
  assert(deepseekDashboard.totals.today === 23, "DeepSeek counted tokens include cache buckets");
  assert(deepseekDashboard.topModel === "deepseek-chat", "DeepSeek model reaches the Lite chart");
  assert(deepseekDashboard.chart.at(-1).models["deepseek-chat"] === 23, "DeepSeek model total reaches the current day");
  deepseekChild.kill("SIGTERM");
  await new Promise((resolve) => deepseekChild.once("close", resolve));
  if (process.platform !== "win32") {
    assert(!existsSync(join(fixture, "runtime-lite.lock")), "DeepSeek Lite runtime lock cleanup");
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

function writeThemePack(root, id, options) {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const manifest = {
    schemaVersion: options.schemaVersion || 1,
    id,
    name: options.name,
    subtitle: options.subtitle,
    description: "Synthetic theme fixture",
    author: "Vibe Tree Lite tests",
    version: "1.0.0",
    colorScheme: "dark",
    entry: options.entry || "theme.css",
  };
  if (options.mascot) {
    manifest.mascot = {
      asset: options.mascot === true ? "assets/mascot.png" : options.mascot.asset,
      slot: "chart-rail",
      motion: options.motion || "ambient",
      desktopSize: 132,
      mobileSize: 72,
      states: {
        idle: "idle-bob",
        walk: "rail-walk",
        syncing: "typing",
        success: "hop-star",
        empty: "sleep",
        error: "concerned",
      },
    };
    if (options.mascot === true) {
      mkdirSync(join(directory, "assets"), { recursive: true });
      writeFileSync(join(directory, "assets", "mascot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    }
  }
  writeFileSync(join(directory, "theme.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "theme.css"), options.css, "utf8");
}

function testThemeCss(marker) {
  return `:root {
    --vt-color-background: #10131a;
    --vt-color-surface: #171b24;
    --vt-color-foreground: #f4f6fb;
    --vt-color-primary: #6e9dff;
    --vt-color-secondary: #f2c66d;
    --vt-body-background: linear-gradient(#10131a, #171b24);
    --vt-chart-1: #6e9dff;
    --vt-chart-2: #f2c66d;
    --vt-test-marker: ${marker};
  }\n`;
}

function deepseekSessionLog(time) {
  const records = [
    { type: "session", version: 0, id: "lite-deepseek-fixture", createdAt: time, seedLength: 0 },
    { type: "step/start", seq: 0, time, data: { turn: 0, step: 0 } },
    { type: "request/header", seq: 1, time, data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } } } },
    {
      type: "assistant/message",
      seq: 2,
      time,
      data: {
        turn: 0,
        step: 0,
        usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 },
      },
    },
    { type: "step/end", seq: 3, time, data: { turn: 0, step: 0 } },
  ];
  return `${records.map(JSON.stringify).join("\n")}\n`;
}

async function waitForDashboard(base, predicate) {
  const deadline = Date.now() + 10000;
  let dashboard;
  while (Date.now() < deadline) {
    dashboard = await fetch(`${base}/api/dashboard?days=30`).then((response) => response.json());
    if (predicate(dashboard)) return dashboard;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`DeepSeek Lite dashboard timeout: ${JSON.stringify(dashboard)}`);
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
