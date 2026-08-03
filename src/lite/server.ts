import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { AchievementState, LeaderboardCollection, LeaderboardRange, SessionMonitorStatus, UsageEvent, UsageStatus } from "../shared/types.js";
import { APP_NAME } from "../shared/appMetadata.js";
import { MAIN_TEXT } from "../electron/i18n.js";
import { createLeaderboardService, type LeaderboardRequestJsonOptions } from "../electron/leaderboard.js";
import { startCodexSessionWatcher } from "../electron/codexSessionWatcher.js";
import {
  startClaudeSessionWatcher,
  startGeminiSessionWatcher,
  startHermesSessionWatcher,
  startKimiSessionWatcher,
  startOpenClawSessionWatcher,
  startOpenCodeSessionWatcher,
  startPiSessionWatcher,
} from "../electron/agentSessionWatchers.js";
import { LiteStore } from "./store.js";

const VERSION = "0.8.2-lite.1";
const DEFAULT_API_URL = "https://vibe-tree-leaderboard.melanthascherffmugutubu.workers.dev";
const PORT = numericEnv("VIBE_TREE_LITE_PORT", 47831, 0, 65535);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.VIBE_TREE_USER_DATA_DIR?.trim() || defaultDataDir();
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const DISABLE_SYNC = process.env.VIBE_TREE_LITE_DISABLE_SYNC === "1";
const DISABLE_WATCHERS = process.env.VIBE_TREE_LITE_DISABLE_WATCHERS === "1";
const MAX_SYNC_RESPONSE_CHARS = 16 * 1024 * 1024;
const csrfToken = randomBytes(24).toString("base64url");
const store = new LiteStore(DATA_DIR);
const watcherStatus = emptyUsageStatus();
const watchers: Array<{ close: () => void }> = [];
let leaderboardCache: { loadedAt: number; value: LeaderboardCollection } | undefined;
let localDashboardCache: { dataVersion: number; days: number; value: ReturnType<LiteStore["dashboard"]> } | undefined;
let changeVersion = 0;
let dataVersion = 0;
let lockHeld = false;
let usageSyncTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let syncAllPromise: ReturnType<typeof performSyncAll> | undefined;

const service = createLeaderboardService({
  apiUrl: (process.env.VIBE_TREE_LEADERBOARD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
  appName: `${APP_NAME} Lite`,
  syncIntervalMs: 60 * 60 * 1000,
  cloudSyncIntervalMs: 60 * 60 * 1000,
  authTimeoutMs: 2 * 60 * 1000,
  callbackPath: "/leaderboard/auth/callback",
  authPath: () => store.path("leaderboard-auth.json"),
  cloudSyncPath: () => store.path("cloud-sync.json"),
  deviceId: () => store.ensureDeviceId(),
  deviceInfo: () => ({ deviceId: store.ensureDeviceId(), alias: platformLabel(), platform: platformId() }),
  cloudModelStats: store.cloudModelStats,
  getLedger: () => store.ledger,
  updateSettings: (partial) => store.updateSettings(partial),
  appendRemoteEntries: store.appendRemoteEntries,
  getAchievements: () => store.achievements,
  mergeRemoteAchievements: store.mergeRemoteAchievements,
  xpForEntry: store.xpForEntry,
  dateKey,
  currentAppVersion: () => VERSION,
  mainText: (key) => MAIN_TEXT[store.ledger.settings.language]?.[key] ?? MAIN_TEXT["zh-CN"][key] ?? key,
  openExternal,
  readJsonFile: <T>(path: string) => readJson<T>(path),
  writeJsonAtomic: (path, value) => store.writeJsonAtomic(path, value),
  broadcastStatus: () => { changeVersion += 1; },
  requestJson: requestJsonWithFetch,
});

store.onChange(() => {
  changeVersion += 1;
  dataVersion += 1;
});

await acquireRuntimeLock();
service.readAuth();
if (!DISABLE_WATCHERS) startWatchers();
if (!DISABLE_SYNC) service.startSync();

const server = http.createServer(async (request, response) => {
  try {
    if (!validHost(request.headers.host)) return sendText(response, 421, "Invalid host");
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, version: VERSION, changeVersion });
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      const days = Number(url.searchParams.get("days") ?? 30);
      return sendJson(response, 200, await dashboardPayload(days));
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      if (!validMutation(request)) return sendJson(response, 403, { error: "请求校验失败，请刷新页面后重试。" });
      if (url.pathname === "/api/sync") return sendJson(response, 200, await syncAll());
      if (url.pathname === "/api/connect-existing") return sendJson(response, 200, await connectExisting());
      if (url.pathname === "/api/connect-new") return sendJson(response, 200, await connectNew());
      return sendJson(response, 404, { error: "Not found" });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendText(response, 405, "Method not allowed");
    return serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    console.error("Vibe Tree Lite request failed:", error instanceof Error ? error.message : error);
    return sendJson(response, 500, { error: "服务处理请求时出错。" });
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`VIBE_TREE_LITE_READY http://${HOST}:${actualPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
process.on("exit", releaseRuntimeLock);

async function dashboardPayload(days: number) {
  const normalizedDays = Math.max(7, Math.min(90, Math.round(Number.isFinite(days) ? days : 30)));
  const local = localDashboardCache?.dataVersion === dataVersion && localDashboardCache.days === normalizedDays
    ? localDashboardCache.value
    : store.dashboard(normalizedDays);
  localDashboardCache = { dataVersion, days: normalizedDays, value: local };
  // The dashboard is a local status/read path. Keep it responsive even when
  // the optional cloud service or proxy is unavailable.
  const cloud = service.cloudStatus();
  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    ...local,
    cloud: {
      configured: cloud.configured,
      authenticated: cloud.authenticated,
      enabled: cloud.enabled,
      syncing: cloud.syncing,
      profile: cloud.profile ? { username: cloud.profile.username, avatarUrl: cloud.profile.avatarUrl } : undefined,
      lastSyncedAt: cloud.lastSyncedAt,
      lastPulledAt: cloud.lastPulledAt,
      lastUploadedCount: cloud.lastUploadedCount,
      lastDownloadedCount: cloud.lastDownloadedCount,
      deviceCount: cloud.devices?.length ?? 0,
      error: cloud.error,
    },
    leaderboard: summarizeLeaderboards(leaderboardCache?.value),
    watchers: summarizeWatchers(watcherStatus),
  };
}

async function syncAll() {
  if (!syncAllPromise) {
    syncAllPromise = performSyncAll().finally(() => { syncAllPromise = undefined; });
  }
  return await syncAllPromise;
}

async function performSyncAll() {
  if (DISABLE_SYNC) return { error: "当前以禁用同步模式运行。" };
  const cloud = await service.syncCloudTree({ force: true, pullFirst: true });
  const leaderboard = await service.syncUsage({ force: true });
  leaderboardCache = undefined;
  return {
    ok: !cloud.error && !leaderboard.error,
    cloud: { lastSyncedAt: cloud.lastSyncedAt, uploaded: cloud.lastUploadedCount, downloaded: cloud.lastDownloadedCount, error: cloud.error },
    leaderboard: { lastSyncedAt: leaderboard.lastSyncedAt, error: leaderboard.error },
  };
}

async function connectExisting() {
  if (DISABLE_SYNC) return { error: "当前以禁用同步模式运行。" };
  const status = await service.joinCloudTree();
  if (!status.error) {
    store.updateSettings({ treeStartMode: "cloud" });
    restartWatchers();
  }
  leaderboardCache = undefined;
  return { ok: !status.error, error: status.error };
}

async function connectNew() {
  if (DISABLE_SYNC) return { error: "当前以禁用同步模式运行。" };
  if (!store.ledger.settings.treeStartMode) store.updateSettings({ treeStartMode: "new" });
  const status = await service.enableCloudSync();
  if (!status.error) restartWatchers();
  leaderboardCache = undefined;
  return { ok: !status.error, error: status.error };
}

async function getLeaderboards(force = false) {
  if (DISABLE_SYNC) return undefined;
  if (!force && leaderboardCache && Date.now() - leaderboardCache.loadedAt < 5 * 60 * 1000) return leaderboardCache.value;
  const value = await service.getLeaderboards();
  leaderboardCache = { loadedAt: Date.now(), value };
  return value;
}

function summarizeLeaderboards(collection: LeaderboardCollection | undefined) {
  const ranges: LeaderboardRange[] = ["24h", "7d", "30d", "all"];
  return Object.fromEntries(ranges.map((range) => {
    const data = collection?.ranges?.[range];
    return [range, data ? { rank: data.me?.rank, tokens: data.me?.tokens, users: data.entries.length, updatedAt: data.updatedAt, error: data.error } : {}];
  }));
}

function startWatchers() {
  closeWatchers();
  if (!store.ledger.settings.treeStartMode) return;
  const enabled = new Set(store.ledger.settings.enabledSourceIds);
  const common = { userDataPath: DATA_DIR, historyStartAt: store.ledger.installedAt };
  const add = (id: keyof UsageStatus, start: () => { close: () => void }) => {
    if (!enabled.has(sourceSettingId(id))) return;
    watchers.push(start());
  };
  add("codexSession", () => startCodexSessionWatcher({
    ...common,
    sessionsRoot: store.ledger.settings.codexSessionsDir,
    onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.codexSession = status; changeVersion += 1; },
  }));
  add("claudeSession", () => startClaudeSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.claudeSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.claudeSession = status; changeVersion += 1; },
  }));
  add("openclawSession", () => startOpenClawSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.openclawSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.openclawSession = status; changeVersion += 1; },
  }));
  add("piSession", () => startPiSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.piSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.piSession = status; changeVersion += 1; },
  }));
  add("opencodeSession", () => startOpenCodeSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.opencodeSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.opencodeSession = status; changeVersion += 1; },
  }));
  add("geminiSession", () => startGeminiSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.geminiSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.geminiSession = status; changeVersion += 1; },
  }));
  add("hermesSession", () => startHermesSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.hermesSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.hermesSession = status; changeVersion += 1; },
  }));
  add("kimiSession", () => startKimiSessionWatcher({
    ...common, sessionsRoot: store.ledger.settings.kimiSessionsDir, onUsage: handleUsage,
    onStatus: (status) => { watcherStatus.kimiSession = status; changeVersion += 1; },
  }));
}

function handleUsage(event: UsageEvent) {
  store.appendUsageEvent(event);
  if (DISABLE_SYNC) return;
  service.scheduleCloudSyncSoon(15_000);
  if (usageSyncTimer) clearTimeout(usageSyncTimer);
  usageSyncTimer = setTimeout(() => {
    usageSyncTimer = undefined;
    void service.syncUsage().then(() => { leaderboardCache = undefined; });
  }, 15_000);
}

function restartWatchers() {
  if (!DISABLE_WATCHERS) startWatchers();
}

function closeWatchers() {
  while (watchers.length) watchers.pop()?.close();
}

function sourceSettingId(id: keyof UsageStatus) {
  return ({
    codexSession: "codex", claudeSession: "claude", openclawSession: "openclaw", piSession: "pi",
    opencodeSession: "opencode", geminiSession: "gemini", hermesSession: "hermes", kimiSession: "kimi",
  } as const)[id];
}

function summarizeWatchers(status: UsageStatus) {
  return Object.values(status).reduce((summary, item) => {
    if (item.running) summary.running += 1;
    if (item.exists) summary.detected += 1;
    summary.eventsImported += item.eventsImported;
    if (item.lastScanAt && (!summary.lastScanAt || item.lastScanAt > summary.lastScanAt)) summary.lastScanAt = item.lastScanAt;
    return summary;
  }, { running: 0, detected: 0, eventsImported: 0, lastScanAt: undefined as string | undefined });
}

function emptyUsageStatus(): UsageStatus {
  const empty = (): SessionMonitorStatus => ({ running: false, sessionsRoot: "", exists: false, filesWatched: 0, eventsImported: 0, importHistory: false });
  return {
    codexSession: empty(), claudeSession: empty(), openclawSession: empty(), piSession: empty(),
    opencodeSession: empty(), geminiSession: empty(), hermesSession: empty(), kimiSession: empty(),
  };
}

function serveStatic(pathname: string, response: http.ServerResponse, headOnly: boolean) {
  const files: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml; charset=utf-8" },
  };
  const asset = files[pathname];
  if (!asset) return sendText(response, 404, "Not found");
  const path = join(STATIC_DIR, asset.file);
  let body = readFileSync(path);
  if (asset.file === "index.html") {
    body = Buffer.from(body.toString("utf8").replace("__VIBE_TREE_CSRF_TOKEN__", csrfToken));
  }
  response.writeHead(200, securityHeaders({ "Content-Type": asset.type, "Content-Length": String(body.length), "Cache-Control": "no-cache" }));
  response.end(headOnly ? undefined : body);
}

function validMutation(request: http.IncomingMessage) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return request.headers["x-vibe-tree-token"] === csrfToken && origin === `http://${host}`;
}

function validHost(host: string | undefined) {
  return Boolean(host && (host === `127.0.0.1:${activePort()}` || host === `localhost:${activePort()}`));
}

function activePort() {
  const address = server?.address?.();
  return typeof address === "object" && address ? address.port : PORT;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length), "Cache-Control": "no-store" }));
  response.end(body);
}

function sendText(response: http.ServerResponse, status: number, value: string) {
  const body = Buffer.from(value);
  response.writeHead(status, securityHeaders({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.length) }));
  response.end(body);
}

function securityHeaders(extra: Record<string, string>) {
  return {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}

async function requestJsonWithFetch<T = unknown>(url: string, options: LeaderboardRequestJsonOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        Accept: "application/json",
        "User-Agent": `${APP_NAME}-Lite/${VERSION}`,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > MAX_SYNC_RESPONSE_CHARS) throw new Error("同步服务响应过大");
    const value = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = typeof value?.error === "string" ? value.error : `请求失败 (${response.status})`;
      throw new Error(message);
    }
    return value as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("同步服务请求超时，请检查网络或代理配置。", { cause: error });
    }
    if (error instanceof TypeError && error.message === "fetch failed") {
      throw new Error("无法连接同步服务，请检查网络或代理配置。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readJson<T>(path: string) {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function openExternal(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false, detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function acquireRuntimeLock() {
  if (process.env.VIBE_TREE_LITE_SKIP_LOCK === "1") return;
  await assertElectronNotRunning();
  const path = store.path("runtime-lite.lock");
  const existing = readJson<{ pid?: number }>(path);
  if (existing?.pid && processExists(existing.pid)) throw new Error(`Vibe Tree Lite 已在运行（PID ${existing.pid}）。`);
  if (existsSync(path)) rmSync(path, { force: true });
  const fd = openSync(path, "wx");
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  closeSync(fd);
  lockHeld = true;
}

async function assertElectronNotRunning() {
  if (process.env.VIBE_TREE_LITE_ALLOW_CONCURRENT === "1" || process.platform === "win32") return;
  const output = await commandOutput("ps", ["-axo", "pid=,command="]);
  const conflict = output.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) return false;
    return isElectronCommand(match[2]);
  });
  if (conflict) throw new Error("检测到 Electron 版 Vibe Tree 正在运行。请退出它后再启动 Lite，避免重复写入 token 数据。");
}

function isElectronCommand(command: string) {
  return (
    /^(?:\S*\/)?Vibe Tree\.app\/Contents\/MacOS\/Vibe Tree(?:\s|$)/.test(command) ||
    /^\S*Electron(?:\s+)\S*dist\/electron\/main\.js(?:\s|$)/.test(command)
  );
}

function commandOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`)));
  });
}

function processExists(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  closeWatchers();
  if (usageSyncTimer) clearTimeout(usageSyncTimer);
  service.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  releaseRuntimeLock();
  console.log(`Vibe Tree Lite stopped (${signal})`);
  process.exit(0);
}

function releaseRuntimeLock() {
  if (!lockHeld) return;
  const lockPath = store.path("runtime-lite.lock");
  const lock = readJson<{ pid?: number }>(lockPath);
  if (lock?.pid === process.pid) rmSync(lockPath, { force: true });
  lockHeld = false;
}

function defaultDataDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Vibe Tree");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Vibe Tree");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Vibe Tree");
}

function platformId() {
  return process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unknown";
}

function platformLabel() {
  return process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : "Device";
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function numericEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
