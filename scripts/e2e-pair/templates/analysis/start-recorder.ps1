$ErrorActionPreference='Stop'
$taskScript=Join-Path $PSScriptRoot 'response-recorder.mjs'
$taskState=Join-Path $PSScriptRoot 'recorder-process.json'
if(Test-Path -LiteralPath $taskState){throw 'Recorder identity already exists; inspect owned process before restarting'}
if(Get-NetTCPConnection -State Listen -LocalPort @@RECORDER_PORT@@ -ErrorAction SilentlyContinue){throw 'Recorder loopback port is occupied'}
$taskProcess=Start-Process -FilePath (Get-Command node).Source -ArgumentList @($taskScript) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'recorder-stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'recorder-stderr.log')
[ordered]@{pid=$taskProcess.Id;started_utc=$taskProcess.StartTime.ToUniversalTime().ToString('o');script=$taskScript;port=@@RECORDER_PORT@@;loopback_only=$true}|ConvertTo-Json|Set-Content -LiteralPath $taskState
$taskReady=Join-Path (Split-Path $PSScriptRoot) 'data/logs/recorder-ready.json'
$taskDeadline=[DateTime]::UtcNow.AddSeconds(15)
while(-not(Test-Path -LiteralPath $taskReady)){
  if($taskProcess.HasExited -or [DateTime]::UtcNow -ge $taskDeadline){throw 'Recorder did not become ready'}
  Start-Sleep -Milliseconds 200
}
$taskHealth=Invoke-RestMethod -Uri http://127.0.0.1:@@RECORDER_PORT@@/__e2e_recorder_health -TimeoutSec 5
if(-not $taskHealth.ok){throw 'Recorder is unhealthy'}
Write-Output 'Recorder ready on loopback, headers and explicit reasoning fields excluded.'
