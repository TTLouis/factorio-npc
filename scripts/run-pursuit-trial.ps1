param([string]$Container = 'goal-pursuit-live-20261010')
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence = Join-Path $repo 'test-results/goal-pursuit-2026-10-10/live'
if ($Container -ne 'goal-pursuit-live-20261010') { throw 'Only this experiment container is authorized.' }
$mount = (& docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' $Container).Trim()
if ($LASTEXITCODE -ne 0 -or $mount.Replace('\','/').TrimEnd('/') -ne (Join-Path $evidence 'data').Replace('\','/').TrimEnd('/')) { throw 'Isolated data mount mismatch.' }
if (Test-Path -LiteralPath (Join-Path $evidence 'watchdog-started.json')) { throw 'This single trial has already been launched.' }
$releaseStart = (& docker exec $Container readlink -f /opt/sgluna/start-sgluna.sh).Trim()
if ($LASTEXITCODE -ne 0 -or $releaseStart -notmatch '^/opt/sgluna/\.sgluna/releases/[a-zA-Z0-9_-]+/start-sgluna\.sh$') { throw 'Cannot identify pinned runtime binary.' }
$nodeBinary = $releaseStart.Replace('/start-sgluna.sh', '/node/bin/node')
$marker = [System.IO.File]::Open((Join-Path $evidence 'watchdog-started.json'), [System.IO.FileMode]::CreateNew)
try { $marker.Write([System.Text.Encoding]::UTF8.GetBytes('{"single_trial":true}'), 0, 21); $marker.Flush($true) } finally { $marker.Dispose() }
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$limitMs = 1190000 # 19m50s; reserve ten seconds for stop command latency.
$process = $null
$reason = 'controller_exit'
try {
    $process = Start-Process -FilePath 'docker' -WindowStyle Hidden -PassThru -ArgumentList @('exec', $Container, $nodeBinary, '/e2e/pursuit_live.mjs', '--go') -RedirectStandardOutput (Join-Path $evidence 'controller.log') -RedirectStandardError (Join-Path $evidence 'controller-error.log')
    while (-not $process.HasExited -and $clock.ElapsedMilliseconds -lt $limitMs) { Start-Sleep -Milliseconds 500; $process.Refresh() }
    if (-not $process.HasExited) { $reason = 'external_wall_limit' }
} finally {
    # SIGKILL closes every container process immediately, including native work
    # and provider requests. No grace period or post-cap gameplay is permitted.
    & docker kill $Container *> (Join-Path $evidence 'watchdog-stop.log')
    $stopExit = $LASTEXITCODE
    $record = @{ reason=$reason; elapsed_ms=$clock.ElapsedMilliseconds; limit_ms=$limitMs; stop_exit=$stopExit; controller_exit=if ($process.HasExited) { $process.ExitCode } else { $null } }
    [System.IO.File]::WriteAllText((Join-Path $evidence 'watchdog.json'), ($record | ConvertTo-Json))
    if ($stopExit -ne 0) { throw 'Trial watchdog could not stop its isolated container.' }
}
