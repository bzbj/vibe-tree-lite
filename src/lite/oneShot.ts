import type { CloudSyncStatus, LeaderboardStatus, UsageStatus } from "../shared/types.js";

/**
 * One-shot scan-and-sync run used when Vibe Tree Lite is scheduled instead of
 * resident.
 *
 * A resident Lite process polls every session tree on a fixed interval, keeps
 * one timer per source alive forever, and re-arms a usage-upload debounce after
 * every imported event. A device that only wants an hourly "read the totals and
 * push them" pass pays all of that for nothing.
 *
 * This runner performs exactly one pass and returns: sweep every enabled
 * watcher once, let the watchers flush their read positions, run one cloud sync
 * and one leaderboard sync, then hand control back to the caller to exit. The
 * watcher state files keep their per-file offsets, so the next hourly run reads
 * only what those session files appended since this one.
 */

/** Hard ceiling for the whole pass, so a stuck tree cannot keep the job alive. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface OneShotDeps {
  /** Sweeps every enabled watcher once and resolves when they have all settled. */
  scanWatchers: () => Promise<{ error?: string; scanned?: number; failed?: number }>;
  /** Starts the enabled watchers. Their own timers never fire in one pass. */
  startWatchers: () => void;
  /** Closes the watchers, which flushes each one's read positions to disk. */
  closeWatchers: () => void;
  syncCloudTree: (options: { force?: boolean; pullFirst?: boolean }) => Promise<CloudSyncStatus>;
  syncUsage: (options: { force?: boolean }) => Promise<LeaderboardStatus>;
  /**
   * Skips both uploads while still sweeping. Used by the disable-sync mode, and
   * by tests that only need to prove the collector lifecycle of a scheduled run.
   */
  syncDisabled?: boolean;
  /** Marks cached leaderboard reads stale; optional because a one-shot run serves none. */
  invalidateLeaderboardCache?: () => void;
  now?: () => Date;
  log?: (message: string) => void;
  timeoutMs?: number;
}

export interface OneShotResult {
  ok: boolean;
  scanned: number;
  cloud?: { ok: boolean; error?: string; uploaded?: number; downloaded?: number; lastSyncedAt?: string };
  leaderboard?: { ok: boolean; error?: string; lastSyncedAt?: string };
  error?: string;
}

export function resolveOneShotTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VIBE_TREE_LITE_ONESHOT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_TIMEOUT_MS;
  return Math.floor(parsed);
}

export async function runOneShot(deps: OneShotDeps): Promise<OneShotResult> {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? resolveOneShotTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      performOnce(deps, log),
      new Promise<OneShotResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ ok: false, scanned: 0, error: `一次性任务超时（${Math.round(timeoutMs / 1000)}s）` });
        }, timeoutMs);
        // A one-shot run must be able to exit even while the timer is pending.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function performOnce(deps: OneShotDeps, log: (message: string) => void): Promise<OneShotResult> {
  const startedAt = Date.now();
  const result: OneShotResult = { ok: false, scanned: 0 };

  deps.startWatchers();
  try {
    const swept = await deps.scanWatchers();
    if (swept.error) {
      result.error = swept.error;
      log(`扫描未执行：${swept.error}`);
    }
    result.scanned = swept.scanned ?? 0;
    log(`扫描完成：${result.scanned} 个采集源，用时 ${Date.now() - startedAt}ms`);
  } finally {
    // Closing flushes each watcher's read positions, so a partially scanned
    // tree still resumes from where this run stopped instead of being reread.
    deps.closeWatchers();
  }

  const cloud = deps.syncDisabled
    ? undefined
    : await deps.syncCloudTree({ force: true, pullFirst: true });
  if (deps.syncDisabled) {
    log("同步已禁用：本次仅执行扫描");
  } else if (cloud) {
    result.cloud = {
      ok: !cloud.error,
      error: cloud.error,
      uploaded: cloud.lastUploadedCount,
      downloaded: cloud.lastDownloadedCount,
      lastSyncedAt: cloud.lastSyncedAt,
    };
    log(cloud.error ? `云端同步失败：${cloud.error}` : `云端同步完成（上传 ${cloud.lastUploadedCount ?? 0}，下载 ${cloud.lastDownloadedCount ?? 0}）`);
  }

  const leaderboard = deps.syncDisabled ? undefined : await deps.syncUsage({ force: true });
  if (leaderboard) {
    result.leaderboard = { ok: !leaderboard.error, error: leaderboard.error, lastSyncedAt: leaderboard.lastSyncedAt };
    log(leaderboard.error ? `排行榜上报失败：${leaderboard.error}` : "排行榜上报完成");
  }

  deps.invalidateLeaderboardCache?.();
  result.ok = !result.error && !result.cloud?.error && !result.leaderboard?.error;
  log(`一次性任务结束，用时 ${Date.now() - startedAt}ms`);
  return result;
}

/** Summarizes watcher status for the run log without depending on the server. */
export function summarizeScan(status: UsageStatus) {
  return Object.values(status).reduce(
    (summary, item) => {
      if (item.running) summary.running += 1;
      if (item.exists) summary.detected += 1;
      summary.eventsImported += item.eventsImported;
      return summary;
    },
    { running: 0, detected: 0, eventsImported: 0 },
  );
}
