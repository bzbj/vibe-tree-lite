# Vibe Tree Lite · 阳光积木

简体中文 | [English](README.en.md)

一个不启动 Electron 的本地 Token 统计与多设备同步服务。后台只运行 Node.js，浏览器仅用于查看数据；关掉网页后，Token 采集和 GitHub 云同步仍会继续。

![Vibe Tree Lite 阳光积木桌面版](docs/images/vibe-tree-lite-sunlit-blocks.png)

> 截图使用合成演示数据，不包含真实账号或 Token 用量。

## 保留了什么

- Codex、Claude Code、OpenClaw、Pi Agent、OpenCode、Gemini、Hermes 和 Kimi Code 的本地用量采集。
- 今日、最近 30 日和累计 Token 汇总。
- 最近 30 天的每日柱状图，并按模型堆叠显示。
- 点击模型图例或柱状图方块进行高亮、筛选和查看占比。
- 使用同一个 GitHub 账号，在 macOS 与 Windows 之间同步聚合后的 Token 数据。
- 与原版 Vibe Tree 相同的本地历史和云同步协议。

Lite 不包含桌面树、天气、等级、成就、分享卡片、排行榜页面或 Electron/Chromium 渲染进程。

### 手机窄屏

<img src="docs/images/vibe-tree-lite-sunlit-blocks-mobile.png" width="390" alt="Vibe Tree Lite 阳光积木手机版">

## 环境要求

- Node.js 22 或更新版本
- Git
- macOS 或 Windows

## macOS 安装

先退出原版 Electron Vibe Tree，再执行：

```bash
git clone https://github.com/bzbj/vibe-tree-lite.git
cd vibe-tree-lite
npm ci
npm run install:lite:mac
```

打开 <http://127.0.0.1:47831>。安装器会注册当前用户的 LaunchAgent，登录系统后自动启动 Lite；不会删除原版应用或历史 Token 数据。

更新到最新版：

```bash
cd vibe-tree-lite
git pull --ff-only
npm ci
npm run install:lite:mac
```

卸载后台服务但保留 Token 数据：

```bash
npm run uninstall:lite:mac
```

## Windows 安装

在 PowerShell 中执行：

```powershell
git clone https://github.com/bzbj/vibe-tree-lite.git
Set-Location .\vibe-tree-lite
npm.cmd ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-lite-windows.ps1
```

安装器会把无 Electron 的运行包安装到 `%LOCALAPPDATA%\VibeTreeLite`，注册当前用户计划任务，并创建开始菜单快捷方式。

更新到最新版：

```powershell
Set-Location .\vibe-tree-lite
git pull --ff-only
npm.cmd ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-lite-windows.ps1
```

卸载计划任务与快捷方式但保留 Token 数据：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-lite-windows.ps1
```

## 多设备 GitHub 同步

1. 在每台设备上安装并打开本地页面。
2. 点击“使用 GitHub 登录”，在浏览器中完成授权。
3. 两台设备使用同一个 GitHub 账号。Lite 会自动查找已有云端数据：找到后加入，没有则从本机创建。
4. 顶栏显示 `GitHub · 用户名` 后，点击“立即同步”可手动检查；后台也会定时同步。

同步的是按天、设备、来源和模型聚合后的 Token 数据，不会上传代码、Prompt、回复、会话正文或本地路径。完整说明见 [PRIVACY.md](PRIVACY.md)。

## 支持的数据源

| Agent | 默认数据来源 |
| --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| OpenClaw | `~/.openclaw/agents/**/sessions/*.jsonl` |
| Pi Agent | `~/.pi/agent/sessions/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db`，兼容旧版 JSON |
| Gemini | 本地 Gemini 会话目录 |
| Hermes | 本地 Hermes 会话目录 |
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl` |

安装后会自动检测可用来源。不要同时运行 Electron Vibe Tree 和 Vibe Tree Lite：两者会使用相同的 watcher 游标与事件文件。

## 手动运行与验证

不安装后台服务，仅在当前终端运行：

```bash
npm ci
npm run build:lite
npm run start:lite
```

项目检查：

```bash
npm run test:lite
npm run typecheck
```

更多端口、数据目录、自托管同步服务等配置见 [LITE.md](LITE.md)。

## 安全边界

- HTTP 服务只监听 `127.0.0.1`。
- 写操作需要随机页面令牌和同源请求。
- 页面 API 不返回 GitHub bearer token、设备 ID、本地路径或其他用户资料。
- 默认沿用原版 Vibe Tree 的本地数据目录，升级和卸载 Lite 都不会主动删除历史数据。

## License

MIT
