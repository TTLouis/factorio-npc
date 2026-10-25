$ErrorActionPreference='Stop'
$taskState=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recorder-process.json') -Raw|ConvertFrom-Json -DateKind String
$taskProcess=Get-Process -Id $taskState.pid -ErrorAction SilentlyContinue
if($taskProcess){
  $identityMatches=$taskProcess.StartTime.ToUniversalTime().Ticks -eq [DateTimeOffset]::Parse($taskState.started_utc).UtcDateTime.Ticks
  $taskCommand=(Get-CimInstance Win32_Process -Filter "ProcessId=$($taskState.pid)").CommandLine
  if($taskProcess.ProcessName -ne 'node' -or -not $identityMatches -or -not $taskCommand.Contains([string]$taskState.script)){throw 'Recorder process identity changed; refusing to stop'}
  try{Invoke-RestMethod -Uri http://127.0.0.1:@@RECORDER_PORT@@/__e2e_recorder_health -TimeoutSec 5|ConvertTo-Json|Set-Content (Join-Path $PSScriptRoot 'recorder-final-health.json')}catch{}
  Stop-Process -Id $taskState.pid -ErrorAction Stop
  $taskProcess.WaitForExit(5000)|Out-Null
}
$taskRemaining=Get-NetTCPConnection -State Listen -LocalPort @@RECORDER_PORT@@ -ErrorAction SilentlyContinue|Where-Object OwningProcess -EQ $taskState.pid
if($taskRemaining -or (Get-Process -Id $taskState.pid -ErrorAction SilentlyContinue)){throw 'Recorder cleanup incomplete'}
[ordered]@{at=[DateTime]::UtcNow.ToString('o');pid=$taskState.pid;process_absent=$true;owned_listener_absent=$true}|ConvertTo-Json|Set-Content (Join-Path $PSScriptRoot 'recorder-cleanup.json')
