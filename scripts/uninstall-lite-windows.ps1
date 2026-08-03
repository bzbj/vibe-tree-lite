param(
  [switch]$RemoveProgramFiles
)

$ErrorActionPreference = "Stop"
$taskName = "VibeTreeLite.Headless.Local"
$installRoot = Join-Path $env:LOCALAPPDATA "VibeTreeLite"
$launcherRoot = Join-Path $installRoot "Launcher"
$stopScript = Join-Path $launcherRoot "Stop-VibeTreeLite.ps1"

if (Test-Path -LiteralPath $stopScript) {
  & $stopScript -TaskName $taskName
} else {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") { Stop-ScheduledTask -TaskName $taskName }
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Vibe Tree Lite.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}

if ($RemoveProgramFiles -and (Test-Path -LiteralPath $installRoot)) {
  $resolvedRoot = (Resolve-Path -LiteralPath $installRoot).Path
  $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "VibeTreeLite"))
  if ($resolvedRoot -ne $expectedRoot) { throw "Refusing to remove unexpected path $resolvedRoot." }
  Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}

Write-Output "Vibe Tree Lite task and shortcut removed. Token data was preserved."
