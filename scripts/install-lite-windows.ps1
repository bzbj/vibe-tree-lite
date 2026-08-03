param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "VibeTreeLite"),
  [string]$DataDir,
  [string]$EnvironmentFile
)

$ErrorActionPreference = "Stop"
$taskName = "VibeTreeLite.Headless.Local"
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot "dist\vibe-tree-lite"
$appRoot = Join-Path $InstallRoot "app"
$launcherRoot = Join-Path $InstallRoot "Launcher"
$serverPath = Join-Path $appRoot "lite\server.js"

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeVersion = (& $nodeCommand.Source --version).TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.0.0") {
  throw "Vibe Tree Lite requires Node.js 22 or newer; found $nodeVersion."
}

if (-not (Test-Path -LiteralPath $packageRoot)) {
  Push-Location $repoRoot
  try {
    & npm.cmd run package:lite
    if ($LASTEXITCODE -ne 0) { throw "npm run package:lite failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "lite\server.js"))) {
  throw "Packaged Lite server not found at $packageRoot."
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
  $installedStop = Join-Path $launcherRoot "Stop-VibeTreeLite.ps1"
  if (Test-Path -LiteralPath $installedStop) {
    & $installedStop -TaskName $taskName
  } elseif ($existingTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName
  }
}

[System.IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
if (Test-Path -LiteralPath $appRoot) {
  $suffix = Get-Date -Format "yyyyMMdd-HHmmss"
  $previousRoot = Join-Path $InstallRoot "app.previous-$suffix"
  Move-Item -LiteralPath $appRoot -Destination $previousRoot
}
[System.IO.Directory]::CreateDirectory($appRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($launcherRoot) | Out-Null

Get-ChildItem -Force -LiteralPath $packageRoot | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $appRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "windows\Start-VibeTreeLite.ps1") -Destination $launcherRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "windows\Stop-VibeTreeLite.ps1") -Destination $launcherRoot -Force

if (-not $DataDir) {
  $candidates = @(
    (Join-Path $env:APPDATA "Electron"),
    (Join-Path $env:APPDATA "Vibe Tree"),
    (Join-Path $env:APPDATA "vibe-tree")
  )
  $DataDir = $candidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ "usage-events.jsonl") } |
    Select-Object -First 1
  if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA "Vibe Tree" }
}
[System.IO.Directory]::CreateDirectory($DataDir) | Out-Null

if ($EnvironmentFile) {
  if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    throw "Environment file not found: $EnvironmentFile"
  }
  $EnvironmentFile = (Resolve-Path -LiteralPath $EnvironmentFile).Path
}

$config = [ordered]@{
  nodePath = $nodeCommand.Source
  serverPath = $serverPath
  userDataDir = $DataDir
  dashboardUrl = "http://127.0.0.1:47831"
  environmentFile = $EnvironmentFile
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $launcherRoot "config.json") -Encoding utf8

$powerShellCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $powerShellCommand) {
  $powerShellCommand = Get-Command powershell.exe -ErrorAction Stop
}
$powerShellPath = $powerShellCommand.Source
$startScript = Join-Path $launcherRoot "Start-VibeTreeLite.ps1"
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $InstallRoot
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Headless Vibe Tree Lite local token dashboard" -Force | Out-Null

$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$shortcutPath = Join-Path $programs "Vibe Tree Lite.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot "explorer.exe"
$shortcut.Arguments = "http://127.0.0.1:47831"
$shortcut.WorkingDirectory = $InstallRoot
$shortcut.Description = "Open the local Vibe Tree Lite dashboard"
$shortcut.Save()

Start-ScheduledTask -TaskName $taskName
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:47831/api/health" -TimeoutSec 2
    if ($health.ok) { $ready = $true; break }
  } catch {}
}
if (-not $ready) {
  $logPath = Join-Path $InstallRoot "logs\vibe-tree-lite.log"
  throw "Vibe Tree Lite did not become healthy. Check $logPath."
}

[pscustomobject]@{
  TaskName = $taskName
  InstallRoot = $InstallRoot
  DataDir = $DataDir
  Dashboard = "http://127.0.0.1:47831"
  Version = $health.version
  Status = "Running"
}
