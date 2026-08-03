param(
  [string]$TaskName = "VibeTreeLite.Headless.Local"
)

$ErrorActionPreference = "Stop"
$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $launcherRoot "config.json"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
}

if (-not (Test-Path -LiteralPath $configPath)) {
  return
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$lockPath = Join-Path ([string]$config.userDataDir) "runtime-lite.lock"
if (-not (Test-Path -LiteralPath $lockPath)) {
  return
}

$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
$processId = [int]$lock.pid
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
if ($process) {
  $expectedServer = [string]$config.serverPath
  if ($process.Name -ne "node.exe" -or $process.CommandLine -notlike "*$expectedServer*") {
    throw "Refusing to stop PID $processId because it is not the installed Vibe Tree Lite server."
  }
  Stop-Process -Id $processId -Force
  Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
}

if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
