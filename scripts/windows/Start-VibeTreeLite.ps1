$ErrorActionPreference = "Stop"

$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $launcherRoot "config.json"
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

if ($config.environmentFile) {
  $environmentFile = [string]$config.environmentFile
  if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Vibe Tree Lite environment file not found: $environmentFile"
  }

  foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

$env:VIBE_TREE_USER_DATA_DIR = [string]$config.userDataDir
$env:NODE_USE_ENV_PROXY = "1"

$logRoot = Join-Path (Split-Path -Parent $launcherRoot) "logs"
[System.IO.Directory]::CreateDirectory($logRoot) | Out-Null
$logPath = Join-Path $logRoot "vibe-tree-lite.log"

"[$(Get-Date -Format o)] Starting Vibe Tree Lite" | Add-Content -LiteralPath $logPath
& ([string]$config.nodePath) ([string]$config.serverPath) >> $logPath 2>&1
$exitCode = $LASTEXITCODE
"[$(Get-Date -Format o)] Vibe Tree Lite exited with code $exitCode" | Add-Content -LiteralPath $logPath
exit $exitCode
