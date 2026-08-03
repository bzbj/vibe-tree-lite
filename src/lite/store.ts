import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  AchievementState,
  AchievementUnlock,
  CloudModelStat,
  LedgerEntry,
  LedgerFile,
  Settings,
  UsageEvent,
} from "../shared/types.js";
import { countedInputTokensForEntry, countedTokensForEntry } from "../shared/tokenAccounting.js";

const SOURCE_IDS = ["codex", "openclaw", "pi", "opencode", "claude", "gemini", "hermes", "kimi", "cloud"];

const DEFAULT_SETTINGS: Settings = {
  locked: false,
  alwaysOnTop: false,
  language: "zh-CN",
  uiTheme: "night",
  scale: 1,
  badgeFrontMetric: "total",
  badgeBackMetric: "rate",
  totalDisplayUnit: "m",
  updateCheckEnabled: false,
  leaderboardEnabled: false,
  leaderboardAutoSyncEnabled: true,
  leaderboardPreferencesPublic: false,
  socialGroupCount: 0,
  cloudSyncEnabled: false,
  cloudSyncAutoSyncEnabled: true,
  launchOnStartup: false,
  silentStartup: true,
  enabledSourceIds: [...SOURCE_IDS],
  sourceCatalogVersion: 1,
  menubarVizIds: [],
};

interface CloudSyncFile {
  modelStats?: CloudModelStat[];
}

export interface LiteChartDay {
  date: string;
  total: number;
  models: Record<string, number>;
}

export class LiteStore {
  ledger: LedgerFile;
  achievements: AchievementState;
  readonly dataDir: string;
  private entryIds = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.ledger = this.readLedger();
    this.achievements = this.readAchievements();
    this.resetEntryIds();
  }

  path(name: string) {
    return join(this.dataDir, name);
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateSettings(partial: Partial<Settings>) {
    this.ledger.settings = normalizeSettings({ ...this.ledger.settings, ...partial });
    this.writeJsonAtomic(this.path("device-settings.json"), this.ledger.settings);
    this.emitChange();
  }

  ensureDeviceId() {
    if (this.ledger.settings.cloudSyncDeviceId) return this.ledger.settings.cloudSyncDeviceId;
    const deviceId = `device_${randomUUID().replace(/-/g, "")}`;
    this.updateSettings({ cloudSyncDeviceId: deviceId });
    return deviceId;
  }

  appendUsageEvent = (event: UsageEvent) => {
    if (this.entryIds.has(event.id)) return;
    const entry: LedgerEntry = {
      id: event.id,
      createdAt: event.createdAt,
      source: event.source,
      tokens: event.totalTokens,
      note: `${event.agent}${event.model ? ` · ${event.model}` : ""}`,
      agent: event.agent,
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      deviceId: this.ensureDeviceId(),
    };
    entry.tokens = countedTokensForEntry(entry);
    this.entryIds.add(entry.id);
    this.ledger.entries.unshift(entry);
    this.appendEntry(entry);
    this.emitChange();
  };

  appendRemoteEntries = (entries: LedgerEntry[]) => {
    let accepted = 0;
    for (const input of entries) {
      if (!isEntry(input) || this.entryIds.has(input.id)) continue;
      const entry: LedgerEntry = {
        ...input,
        tokens: safeTokens(input.tokens),
        syncedFromCloud: true,
      };
      this.entryIds.add(entry.id);
      this.ledger.entries.unshift(entry);
      this.appendEntry(entry);
      accepted += 1;
    }
    if (accepted) {
      this.ledger.entries.sort((left, right) => entryTime(right) - entryTime(left));
      this.emitChange();
    }
    return accepted;
  };

  mergeRemoteAchievements = (unlocked: AchievementUnlock[]) => {
    const ids = new Set(this.achievements.unlocked.map((item) => item.id));
    const accepted = unlocked.filter((item) => !ids.has(item.id));
    if (!accepted.length) return 0;
    this.achievements = { ...this.achievements, unlocked: [...this.achievements.unlocked, ...accepted] };
    this.writeJsonAtomic(this.path("achievements.json"), this.achievements);
    return accepted.length;
  };

  xpForEntry = (entry: LedgerEntry) => {
    const sourceId = statSourceId(entry);
    if (sourceId && !this.ledger.settings.enabledSourceIds.includes(sourceId)) return 0;
    return countedTokensForEntry(entry);
  };

  cloudModelStats = () => {
    const deviceId = this.ensureDeviceId();
    const rows = new Map<string, CloudModelStat>();
    for (const entry of this.ledger.entries) {
      if ((entry.syncedFromCloud || entry.source === "cloud-sync") && entry.deviceId && entry.deviceId !== deviceId) continue;
      const model = cleanLabel(entry.model) ?? cleanLabel(entry.provider);
      if (!model) continue;
      const createdAt = new Date(entry.createdAt);
      if (!Number.isFinite(createdAt.getTime())) continue;
      const source = normalizeEventSource(entry.source, entry.id);
      if (source === "cloud-sync") continue;
      const date = dateKey(createdAt);
      const key = `${deviceId}|${date}|${source}|${model}`;
      const row = rows.get(key) ?? {
        deviceId,
        date,
        source,
        model,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      row.tokens += countedTokensForEntry(entry);
      row.inputTokens = (row.inputTokens ?? 0) + countedInputTokensForEntry(entry);
      row.outputTokens = (row.outputTokens ?? 0) + safeTokens(entry.outputTokens ?? 0);
      row.cacheReadTokens = (row.cacheReadTokens ?? 0) + safeTokens(entry.cacheReadTokens ?? 0);
      row.cacheWriteTokens = (row.cacheWriteTokens ?? 0) + safeTokens(entry.cacheWriteTokens ?? 0);
      rows.set(key, row);
    }
    return [...rows.values()].filter((row) => row.tokens > 0);
  };

  dashboard(days = 30) {
    const safeDays = Math.max(7, Math.min(90, Math.round(days)));
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - safeDays + 1);
    const dates: string[] = [];
    for (let index = 0; index < safeDays; index += 1) {
      const date = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + index);
      dates.push(dateKey(date));
    }

    const byDate = new Map(dates.map((date) => [date, 0]));
    let total = 0;
    for (const entry of this.ledger.entries) {
      const tokens = this.xpForEntry(entry);
      if (tokens <= 0) continue;
      total += tokens;
      const createdAt = new Date(entry.createdAt);
      if (!Number.isFinite(createdAt.getTime())) continue;
      const key = dateKey(createdAt);
      if (byDate.has(key)) byDate.set(key, (byDate.get(key) ?? 0) + tokens);
    }

    const modelRows = new Map<string, CloudModelStat>();
    const mergeEnabledModelRow = (row: CloudModelStat) => {
      const sourceId = statSourceIdForSource(row.source);
      if (sourceId && !this.ledger.settings.enabledSourceIds.includes(sourceId)) return;
      mergeModelRow(modelRows, row);
    };
    for (const row of this.remoteModelStats()) mergeEnabledModelRow(row);
    for (const row of this.cloudModelStats()) mergeEnabledModelRow(row);

    const modelsByDate = new Map<string, Map<string, number>>(dates.map((date) => [date, new Map()]));
    for (const row of modelRows.values()) {
      const models = modelsByDate.get(row.date);
      if (!models) continue;
      models.set(row.model, (models.get(row.model) ?? 0) + safeTokens(row.tokens));
    }

    const chart: LiteChartDay[] = dates.map((date) => {
      const entryTotal = Math.round(byDate.get(date) ?? 0);
      const models: Record<string, number> = Object.fromEntries(
        [...(modelsByDate.get(date) ?? new Map()).entries()]
          .filter(([, tokens]) => tokens > 0)
          .map(([model, tokens]) => [model, Math.round(tokens)]),
      );
      let attributed = Object.values(models).reduce((sum, tokens) => sum + tokens, 0);
      if (entryTotal > 0 && attributed > entryTotal) {
        normalizeModelTotals(models, entryTotal, attributed);
        attributed = entryTotal;
      }
      const dailyTotal = Math.max(entryTotal, attributed);
      if (entryTotal > attributed) models["未识别模型"] = entryTotal - attributed;
      return { date, total: dailyTotal, models };
    });

    const modelTotals = new Map<string, number>();
    for (const day of chart) {
      for (const [model, tokens] of Object.entries(day.models)) {
        modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokens);
      }
    }
    const topModel = [...modelTotals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    const periodTotal = chart.reduce((sum, day) => sum + day.total, 0);

    return {
      days: safeDays,
      today: dates.at(-1),
      totals: {
        today: chart.at(-1)?.total ?? 0,
        period: periodTotal,
        all: Math.round(total),
      },
      topModel,
      chart,
    };
  }

  readJson<T>(name: string) {
    return readJsonFile<T>(this.path(name));
  }

  writeJsonAtomic(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, path);
  }

  private readLedger(): LedgerFile {
    const legacy = readJsonFile<Partial<LedgerFile>>(this.path("ledger.json"));
    const meta = readJsonFile<{ installedAt?: string }>(this.path("usage-meta.json"));
    const installedAt = validIso(meta?.installedAt) ?? validIso(legacy?.installedAt) ?? startOfLocalDayIso(new Date());
    const storedSettings = readJsonFile<Partial<Settings>>(this.path("device-settings.json"));
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(legacy?.settings ?? {}), ...(storedSettings ?? {}) });
    const entries = this.readEntries().filter((entry) => entry.deviceId || entryTime(entry) >= Date.parse(installedAt));
    return { entries, settings, installedAt };
  }

  private readEntries() {
    const path = this.path("usage-events.jsonl");
    if (!existsSync(path)) return [];
    const byId = new Map<string, LedgerEntry>();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = parseJson(line);
      if (isEntry(entry)) byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((left, right) => entryTime(right) - entryTime(left));
  }

  private readAchievements(): AchievementState {
    const state = readJsonFile<AchievementState>(this.path("achievements.json"));
    return { ...state, unlocked: Array.isArray(state?.unlocked) ? state.unlocked : [] };
  }

  private remoteModelStats() {
    const state = readJsonFile<CloudSyncFile>(this.path("cloud-sync.json"));
    return Array.isArray(state?.modelStats) ? state.modelStats : [];
  }

  private appendEntry(entry: LedgerEntry) {
    const path = this.path("usage-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private resetEntryIds() {
    this.entryIds = new Set(this.ledger.entries.map((entry) => entry.id));
  }

  private emitChange() {
    for (const listener of this.listeners) listener();
  }
}

function normalizeSettings(input: Partial<Settings>): Settings {
  const enabled = Array.isArray(input.enabledSourceIds)
    ? [...new Set(input.enabledSourceIds.filter((id): id is string => SOURCE_IDS.includes(id)))]
    : [...SOURCE_IDS];
  if (!enabled.includes("cloud")) enabled.push("cloud");
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    language: input.language === "en-US" ? "en-US" : "zh-CN",
    leaderboardEnabled: input.leaderboardEnabled === true,
    leaderboardAutoSyncEnabled: input.leaderboardAutoSyncEnabled !== false,
    leaderboardPreferencesPublic: input.leaderboardPreferencesPublic === true,
    socialGroupCount: Number.isFinite(input.socialGroupCount) ? Math.max(0, Math.round(input.socialGroupCount ?? 0)) : 0,
    cloudSyncEnabled: input.cloudSyncEnabled === true,
    cloudSyncAutoSyncEnabled: input.cloudSyncAutoSyncEnabled !== false,
    launchOnStartup: input.launchOnStartup === true,
    silentStartup: true,
    enabledSourceIds: enabled,
    menubarVizIds: Array.isArray(input.menubarVizIds) ? input.menubarVizIds : [],
  };
}

function mergeModelRow(rows: Map<string, CloudModelStat>, input: CloudModelStat) {
  const deviceId = cleanLabel(input.deviceId);
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
  const source = normalizeEventSource(input.source);
  const model = cleanLabel(input.model);
  const tokens = safeTokens(input.tokens);
  if (!deviceId || !date || source === "cloud-sync" || !model || tokens <= 0) return;
  const key = `${deviceId}|${date}|${source}|${model}`;
  const current = rows.get(key);
  if (!current || tokens >= current.tokens) rows.set(key, { ...input, deviceId, date, source, model, tokens });
}

function statSourceId(entry: LedgerEntry) {
  const source = entry.source === "cloud-sync" ? normalizeEventSource(entry.source, entry.id) : entry.source;
  if (entry.agent === "codex-desktop") return "codex";
  if (entry.agent === "openclaw") return "openclaw";
  if (entry.agent === "pi-agent") return "pi";
  if (entry.agent?.startsWith("opencode")) return "opencode";
  if (entry.agent?.startsWith("claude-code")) return "claude";
  if (entry.agent === "gemini") return "gemini";
  if (entry.agent === "hermes") return "hermes";
  if (entry.agent === "kimi-code") return "kimi";
  return statSourceIdForSource(source);
}

function statSourceIdForSource(source: string) {
  if (source === "codex-session") return "codex";
  if (source === "openclaw-session") return "openclaw";
  if (source === "pi-session") return "pi";
  if (source === "opencode-session") return "opencode";
  if (source === "claude-session") return "claude";
  if (source === "gemini-session") return "gemini";
  if (source === "hermes-session") return "hermes";
  if (source === "kimi-session") return "kimi";
  return source === "cloud-sync" ? "cloud" : undefined;
}

function normalizeEventSource(value: unknown, eventId?: unknown) {
  const allowed = new Set([
    "manual", "codex-session", "claude-session", "openclaw-session", "pi-session",
    "opencode-session", "gemini-session", "hermes-session", "kimi-session", "cloud-sync",
  ]);
  const source = typeof value === "string" ? value.trim() : "";
  if (source === "cloud-sync" && typeof eventId === "string") {
    const prefix = eventId.split(":", 1)[0] ?? "";
    if (allowed.has(prefix)) return prefix;
  }
  return allowed.has(source) ? source : "cloud-sync";
}

function isEntry(value: unknown): value is LedgerEntry {
  const entry = value as LedgerEntry | undefined;
  return Boolean(
    entry && typeof entry.id === "string" && typeof entry.createdAt === "string" &&
    typeof entry.source === "string" && typeof entry.tokens === "number" && Number.isFinite(entry.tokens),
  );
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfLocalDayIso(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function validIso(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function readJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function entryTime(entry: LedgerEntry) {
  const time = Date.parse(entry.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function cleanLabel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function safeTokens(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeModelTotals(models: Record<string, number>, target: number, currentTotal: number) {
  const scaled = Object.entries(models).map(([model, tokens]) => {
    const exact = (tokens / currentTotal) * target;
    const floor = Math.floor(exact);
    return { model, floor, fraction: exact - floor };
  });
  let remaining = target - scaled.reduce((sum, item) => sum + item.floor, 0);
  for (const item of [...scaled].sort((left, right) => right.fraction - left.fraction)) {
    if (remaining <= 0) break;
    item.floor += 1;
    remaining -= 1;
  }
  for (const item of scaled) models[item.model] = item.floor;
}
