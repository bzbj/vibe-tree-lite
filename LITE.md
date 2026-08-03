# Vibe Tree Lite

Vibe Tree Lite keeps the original Vibe Tree token watchers, daily/model
aggregation, GitHub leaderboard, and cloud-tree protocol. It replaces the
Electron windows, tray, tree, levels, achievements UI, renderer animation, and
desktop updater with one background Node.js process and a local web page.

## What stays

- Codex, Claude Code, OpenClaw, Pi, OpenCode, Gemini, Hermes, and Kimi watchers.
- The original token accounting rule and existing `usage-events.jsonl` history.
- Hourly leaderboard upload and rank lookup.
- Multi-device event/model aggregation through the existing Cloudflare Worker.
- Existing GitHub identity and cloud state in the Vibe Tree data directory.
- A 30-day stacked daily bar chart grouped by model.

## What is removed

- Electron and Chromium renderer processes.
- Tree, weather, levels, achievements presentation, share images, themes, and
  desktop update UI.
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
service. Existing token data is detected and preserved. Re-run the same command
after pulling a newer version to update the installed service.

To remove the task and shortcut while preserving token data:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-lite-windows.ps1
```

Add `-RemoveProgramFiles` only when the installed program files should also be
removed; the Vibe Tree token data directory is still preserved.

## Second device

1. Use the Windows/macOS installer above, or copy the output of
   `npm run package:lite` to the second device.
2. When running a copied package manually, run `node lite/server.js` from the
   packaged `dist/vibe-tree-lite` directory.
3. Open the local page and choose **使用 GitHub 登录**.
4. Complete GitHub login in the browser. Lite reuses the original OAuth
   callback and automatically joins an existing cloud tree or starts one from
   the local data when the account has no remote tree yet.

The packaged runtime has no npm dependencies and does not contain Electron or
`node_modules`; it requires Node.js 22 or newer.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBE_TREE_LITE_PORT` | `47831` | Local dashboard port |
| `VIBE_TREE_USER_DATA_DIR` | Original Vibe Tree data directory | Override data location |
| `VIBE_TREE_LEADERBOARD_API_URL` | Original hosted Worker | Self-hosted sync backend |
| `NODE_USE_ENV_PROXY` | Set to `1` by start/install scripts | Use standard proxy environment variables |
| `VIBE_TREE_LITE_DISABLE_SYNC` | unset | `1` disables network sync for testing |
| `VIBE_TREE_LITE_DISABLE_WATCHERS` | unset | `1` disables local watcher polling for testing |

## Security boundary

- HTTP listens only on `127.0.0.1`.
- Mutating requests require a random same-page token and same-origin header.
- API responses do not expose the GitHub bearer token, device id, local paths,
  prompts, replies, or other leaderboard users' profiles.
- Model bars are built from the same daily/device/model aggregates already used
  by original Vibe Tree cloud sync.

## Validation

```bash
npm run test:lite
npm run typecheck
```

The smoke test uses an isolated temporary data directory and verifies the health
endpoint, today's total, per-model chart data, static dashboard, and request
token injection.
