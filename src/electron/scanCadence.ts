/**
 * Scan cadence shared by every session watcher.
 *
 * Watchers poll their session roots instead of subscribing to filesystem
 * events, because append-only artifacts, torn writes, and file rotation are
 * far more predictable to detect by comparing a record offset than by
 * reacting to platform notification semantics.
 *
 * `VIBE_TREE_LITE_SCAN_INTERVAL_MS` lets a device trade discovery latency for
 * idle quiet: the default stays at ten seconds, and larger values (for example
 * one hour) turn the watchers into a periodic sweep. Because the watchers store
 * their read position per file and persist it, a long interval loses no data —
 * it only delays discovery.
 */

/** Default poll interval, matching the historical fixed cadence. */
export const DEFAULT_SCAN_INTERVAL_MS = 10_000;

/** Shortest accepted interval in milliseconds (one second). */
const MIN_SCAN_INTERVAL_MS = 1_000;

/** Longest accepted interval in milliseconds (24 hours). */
const MAX_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Resolves the poll interval from the environment, ignoring values that are
 * absent, unparsable, or outside the supported range.
 */
export function resolveScanIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VIBE_TREE_LITE_SCAN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SCAN_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_SCAN_INTERVAL_MS || parsed > MAX_SCAN_INTERVAL_MS) {
    return DEFAULT_SCAN_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

/**
 * Checkpoint throttle for persisting scan progress while a sweep is running.
 *
 * The historical behaviour flushed state every fixed number of files, which
 * made write volume scale with the size of the session tree rather than with
 * elapsed time: a large tree rewrote the whole state file dozens of times per
 * sweep even when nothing had changed. Throttling by time keeps crash
 * protection proportional to the interval instead.
 *
 * The checkpoint window never exceeds the interval, so short intervals keep
 * frequent flushes, and it never drops below a floor that would let a long
 * sweep run unprotected for an unreasonable stretch.
 */
export function checkpointIntervalMs(scanIntervalMs: number): number {
  const window = Math.floor(scanIntervalMs / 4);
  const floor = Math.min(30_000, scanIntervalMs);
  return Math.max(1_000, Math.min(Math.max(window, floor), scanIntervalMs));
}
