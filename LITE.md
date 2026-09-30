# Vibe Tree Lite

Vibe Tree Lite keeps the original Vibe Tree token watchers, daily/model
aggregation, GitHub leaderboard, and cloud-tree protocol. It replaces the
Electron windows, tray, tree, levels, achievements UI, renderer animation, and
desktop updater with one background Node.js process and a local web page.

## What stays

- Codex, Claude Code, OpenClaw, Pi, OpenCode, Gemini, Hermes, Kimi, and DeepSeek Harness watchers.
- The original token accounting rule and existing `usage-events.jsonl` history.
- Hourly leaderboard upload and rank lookup.
- Multi-device event/model aggregation through the existing Cloudflare Worker.
- Existing GitHub identity and cloud state in the Vibe Tree data directory.
- A 30-day stacked daily bar chart grouped by model.
- Multiple local CSS-token theme packs with runtime selection and persistence.

## What is removed

- Electron and Chromium renderer processes.
- Tree, weather, levels, achievements presentation, share images, Electron
  themes, and desktop update UI.
- Always-on desktop windows and GPU rendering.

Achievements already present in the cloud file are preserved for compatibility,
but Lite does not calculate or display new achievement/level UI.

## Start

```bash
npm run build:lite
npm run start:lite
```

Open <http://127.0.0.1:47831>. The server binds to loopback only. Close the tab
when finished; token collection and sync continue without a browser renderer.

Do not run Electron Vibe Tree and Vibe Tree Lite at the same time. Lite checks
for an Electron process on startup and stops with an explanation if it finds
one, because both programs would otherwise update the same watcher offsets and
event file.

## Scan cadence

The watchers poll their session roots instead of subscribing to filesystem
events, because append-only artifacts, torn writes, and file rotation are far
more predictable to detect by comparing a recorded offset. The default cadence
is ten seconds.

Set `VIBE_TREE_LITE_SCAN_INTERVAL_MS` to scan less often — for example
`3600000` for one sweep per hour:

```bash
VIBE_TREE_LITE_SCAN_INTERVAL_MS=3600000 npm run start:lite
```

Because each watcher stores and persists its per-file read position, a long
interval does not lose usage: it only delays discovery by up to one interval, so
the local page may lag by that much. Accepted values are one second to 24 hours;
anything absent, unparsable, or outside that range falls back to the default.

A sweep that finds nothing new performs no writes at all. Progress is flushed on
a time-based checkpoint while a sweep runs, so crash protection scales with the
configured interval rather than with the number of session files.

### On-demand refresh

Because a long interval means the page can lag, the toolbar has an **立即刷新**
action next to **立即同步**. It sweeps every enabled watcher immediately and
re-renders when the sweep finishes, so there is no need to wait for the next
scheduled pass or to restart the service.

The two actions are independent: **立即刷新** re-reads the local session roots,
while **立即同步** exchanges the cloud tree and leaderboard over the network.
An idle refresh costs nothing, since a sweep with no new data performs no writes.

## Scheduled one-shot mode

A resident Lite process polls the session roots forever and keeps a timer per
source, which is more than a device that only wants an hourly "read the totals
and upload them" needs. `--once` performs exactly one pass and exits:

```bash
node dist/lite-server/lite/server.js --once     # or: npm run run:lite:once
```

One pass sweeps every enabled watcher, lets each watcher flush its per-file read
position, runs one cloud sync and one leaderboard upload, prints a
`VIBE_TREE_LITE_ONCE_DONE {...}` line with `ok`, and exits `0` (or `1` if a
sweep or either upload failed). It never starts the dashboard server, and it
does not arm the per-event upload debounce. Because the watcher state files keep
their offsets, the next pass reads only what the session files appended since
the previous one — a long gap costs more per pass but is never re-read.

The whole pass is bounded by a hard timeout (15 minutes by default,
`VIBE_TREE_LITE_ONESHOT_TIMEOUT_MS` to change it) so a stuck session tree cannot
keep the process alive.

On macOS, `--schedule` swaps the kept-alive service for a scheduled one:

```bash
npm run install:lite:mac -- --schedule                 # hourly, and once at login
npm run install:lite:mac -- --schedule --interval 1800 # every 30 minutes
npm run install:lite:mac                               # back to the resident dashboard
```

This writes `StartInterval` instead of `KeepAlive` into the LaunchAgent, so
launchd starts the job and lets it exit; nothing polls between passes.
`node scripts/install-lite-macos.mjs --schedule --print-plist` prints the exact
LaunchAgent without touching launchd.

On Windows, register the same command with Task Scheduler:

```powershell
schtasks /Create /TN VibeTreeLite.Hourly /SC HOURLY /MO 1 /F `
  /TR "node \"$env:LOCALAPPDATA\VibeTreeLite\dist\vibe-tree-lite\lite\server.js\" --once"
```

Two things to know about a scheduled pass:

- **launchd and Task Scheduler start the job with no login shell**, so proxy
  environment variables exported by a shell profile are absent. The macOS
  installer reads the current network proxy settings with `scutil --proxy` and
  writes `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` into the LaunchAgent; set those
  environment variables in the scheduled task on Windows if the sync service is
  not directly reachable.
- Sleep does not accumulate missed runs. A wake-up runs the next pass on
  schedule, and the offsets make that safe — it only delays discovery.

## macOS background service

Quit Electron Vibe Tree first, then run:

```bash
npm run install:lite:mac
```

This disables the old Electron `Vibe Tree` login item, installs
`~/Library/LaunchAgents/dev.opengrove.vibe-tree-lite.plist`, and starts the Lite
service at login. It does not delete the Electron app or token data. Lite can be
removed without deleting token data:

```bash
npm run uninstall:lite:mac
```

## Windows background service

Install Node.js 22 or newer, open PowerShell in the repository, then run:

```powershell
npm.cmd ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-lite-windows.ps1
```

The installer builds a dependency-free Lite package, installs it under
`%LOCALAPPDATA%\VibeTreeLite`, registers the current-user scheduled task
`VibeTreeLite.Headless.Local`, creates a Start menu shortcut, and starts the
service through `conhost.exe --headless`, so no PowerShell console window is
shown. Existing token data is detected and preserved. Re-run the same command
after pulling a newer version to update the installed service.

To remove the task and shortcut while preserving token data:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-lite-windows.ps1
```

Add `-RemoveProgramFiles` only when the installed program files should also be
removed; the Vibe Tree token data directory is still preserved.

## Second device

Install on the second machine with the same commands as the first:

```bash
git clone git@github.com:bzbj/vibe-tree-lite.git
cd vibe-tree-lite
npm ci
npm run install:lite:mac -- --schedule   # macOS hourly pass; omit --schedule for the resident dashboard
# Windows: npm.cmd ci && powershell -File .\scripts\install-lite-windows.ps1
```

Then log in once so the device joins the same cloud tree:

1. Open the local page (`npm run start:lite`) or the packaged runtime.
2. Choose **使用 GitHub 登录** and complete GitHub login in the browser.
3. Lite reuses the original OAuth callback and automatically joins an existing
   cloud tree, or starts one from the local data when the account has no remote
   tree yet. After that the scheduled pass uploads hourly without any UI.

Each device uploads its own aggregate snapshot keyed by device id, so two
machines contribute to the same tree without overwriting each other. The
dashboard is not part of a scheduled install; read the shared numbers from
<https://lab.linjunkai.com/vibe-tree/>, or run `npm run start:lite` on demand and
close it again.

To copy a package instead of cloning, use `npm run package:lite` and run
`node lite/server.js` from the packaged `dist/vibe-tree-lite` directory (the
packaged runtime has no npm dependencies, but it still requires Node.js 22 or
newer).

## Theme packs

Sunlit Blocks is bundled as the default. Additional packs are discovered under
the standard Vibe Tree data directory:

- macOS: `~/Library/Application Support/Vibe Tree/themes/<theme-id>/`
- Windows: `%APPDATA%\Vibe Tree\themes\<theme-id>\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Vibe Tree/themes/<theme-id>/`

Each directory contains `theme.json` and `theme.css`. Theme CSS is restricted to
one `:root` block of `--vt-*` custom properties. JavaScript, selectors, remote
imports, `url()`, symlinks, path traversal, and oversized files are not loaded.
Use the top-bar selector after refreshing the page. The active id is stored in
Lite-only `lite-theme.json`; removing an active pack safely falls back to
Sunlit Blocks. See [docs/LITE_THEMES.md](docs/LITE_THEMES.md) for the full
manifest and token contract.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBE_TREE_LITE_PORT` | `47831` | Local dashboard port |
| `VIBE_TREE_USER_DATA_DIR` | Original Vibe Tree data directory | Override data location |
| `VIBE_TREE_LEADERBOARD_API_URL` | Original hosted Worker | Self-hosted sync backend |
| `NODE_USE_ENV_PROXY` | Set to `1` by start/install scripts | Use standard proxy environment variables |
| `VIBE_TREE_LITE_DISABLE_SYNC` | unset | `1` disables network sync for testing |
| `VIBE_TREE_LITE_DISABLE_WATCHERS` | unset | `1` disables local watcher polling for testing |
| `VIBE_TREE_LITE_ONCE` | unset | `1` runs one scan-and-sync pass and exits, same as `--once` |
| `VIBE_TREE_LITE_ONESHOT_TIMEOUT_MS` | `900000` | Hard ceiling for one scheduled pass |
| `VIBE_TREE_DASHBOARD_URL` | `https://lab.linjunkai.com/vibe-tree/` | Page opened by `npm run open:dashboard` |
| `VIBE_DEEPSEEK_SESSIONS_DIR` | `$DSH_HOME/sessions` or `~/.dsh/sessions` | Override the DeepSeek Harness session root |
| `VIBE_DEEPSEEK_IMPORT_HISTORY` | unset | `today` imports today's existing DeepSeek Harness usage instead of only new writes |

## Security boundary

- HTTP listens only on `127.0.0.1`.
- Mutating requests require a random same-page token and same-origin header.
- Theme selection uses the same request boundary; theme APIs expose metadata,
  never install paths or stylesheet filenames.
- API responses do not expose the GitHub bearer token, device id, local paths,
  prompts, replies, or other leaderboard users' profiles.
- Model bars are built from the same daily/device/model aggregates already used
  by original Vibe Tree cloud sync.

## Validation

```bash
npm run test:lite
npm run test:deepseek-watcher
npm run typecheck
```

The smoke test uses isolated temporary data, theme packs, and session
directories. It verifies theme discovery/rejection, CSRF-protected selection,
restart persistence, the dashboard API, and the Lite-to-DeepSeek watcher path.
