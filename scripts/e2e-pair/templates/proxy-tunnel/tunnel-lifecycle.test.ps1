$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'tunnel-lifecycle.ps1')
$fixtures=Join-Path (Split-Path $PSScriptRoot) 'tunnel-lifecycle-fixtures'
if(Test-Path -LiteralPath $fixtures){throw 'Preserve existing tunnel fixture evidence before rerun'}
New-Item -ItemType Directory -Path $fixtures | Out-Null
$script:assertions=0
function Assert-True($Value,[string]$Message){if(-not $Value){throw $Message};$script:assertions++}
function New-Fixture {
  $script:current=$null;$script:stopped=@();$script:address='127.0.0.1';$script:listenerOwner=9001
  $script:created=[pscustomobject]@{Id=9001;ProcessName='ssh';StartTime=[DateTime]::Parse('2026-10-25T10:20:30.1234567Z').ToUniversalTime()}
}
$start={ $script:current=$script:created;return $script:created }
$get={param($ProcessId) if($script:current -and $script:current.Id -eq $ProcessId){return $script:current}}
$stop={param($Process) $script:stopped+=@($Process.Id);$script:current=$null}
$listeners={param($Port) if($script:current){[pscustomobject]@{OwningProcess=$script:listenerOwner;LocalAddress=$script:address}}}

New-Fixture
$statePath=Join-Path $fixtures 'injected-failure.json'
$failed=$false
try {
  Start-OwnedTunnel -StatePath $statePath -LocalPort 1234 -Start $start -GetProcess $get -StopProcess $stop -Listeners $listeners -Wait {
    Assert-True (Test-Path -LiteralPath $statePath) 'Ownership receipt missing before first wait'
    $receipt=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String
    Assert-True ($receipt.PID -eq 9001) 'Wrong recorded PID'
    Assert-True ([DateTimeOffset]::Parse($receipt.StartedUTC).UtcDateTime.Ticks -eq $script:created.StartTime.Ticks) 'Recorded time was not actual process StartTime'
    throw 'Injected failure after process creation'
  } | Out-Null
} catch {$failed=$true}
Assert-True $failed 'Injected failure was accepted'
Assert-True ($script:stopped.Count -eq 1 -and $script:stopped[0] -eq 9001) 'Created process was not cleaned exactly once'
$failure=Get-Content -LiteralPath ($statePath+'.startup-failure.json') -Raw | ConvertFrom-Json
Assert-True ($failure.status -eq 'owned_process_removed' -and $failure.proof.process_absent) 'Failure cleanup proof absent'

New-Fixture
$statePath=Join-Path $fixtures 'changed_identity_after_create.json'
$failed=$false
try {
  Start-OwnedTunnel -StatePath $statePath -LocalPort 1234 -Start $start -GetProcess $get -StopProcess $stop -Listeners $listeners -Wait {
    $script:current=[pscustomobject]@{Id=9001;ProcessName='ssh';StartTime=$script:created.StartTime.AddSeconds(1)}
    throw 'Injected PID reuse before cleanup'
  } | Out-Null
} catch {$failed=$true}
$failure=Get-Content -LiteralPath ($statePath+'.startup-failure.json') -Raw | ConvertFrom-Json
Assert-True ($failed -and $failure.status -eq 'cleanup_refused_or_incomplete') 'Startup failure did not record identity refusal'
Assert-True ($script:stopped.Count -eq 0 -and $script:current) 'Startup cleanup killed a reused PID'

New-Fixture
$statePath=Join-Path $fixtures 'ready.json'
$ready=Start-OwnedTunnel -StatePath $statePath -LocalPort 1234 -Start $start -GetProcess $get -StopProcess $stop -Listeners $listeners -Wait {}
Assert-True ($ready.Status -eq 'ready' -and $ready.ListenerPresent -and $ready.LoopbackOnly) 'Loopback readiness failed'
$script:current=[pscustomobject]@{Id=9001;ProcessName='ssh';StartTime=$script:created.StartTime.AddSeconds(1)}
$refused=$false
try {Stop-OwnedTunnel -State $ready -GetProcess $get -StopProcess $stop -Listeners $listeners | Out-Null} catch {$refused=$true}
Assert-True ($refused -and $script:stopped.Count -eq 0 -and $script:current) 'Reused PID was stopped'
$script:current=[pscustomobject]@{Id=9001;ProcessName='unrelated';StartTime=$script:created.StartTime}
$refused=$false
try {Stop-OwnedTunnel -State $ready -GetProcess $get -StopProcess $stop -Listeners $listeners | Out-Null} catch {$refused=$true}
Assert-True ($refused -and $script:stopped.Count -eq 0 -and $script:current) 'Unrelated process name was stopped'
$script:current=$script:created
Stop-OwnedTunnel -State $ready -GetProcess $get -StopProcess $stop -Listeners $listeners | Out-Null
Assert-True ($script:stopped.Count -eq 1 -and -not $script:current) 'Exact ready process was not cleaned'

foreach($case in @('public_listener','wrong_listener_owner','missing_listener')){
  New-Fixture
  if($case -eq 'public_listener'){$script:address='0.0.0.0'}
  if($case -eq 'wrong_listener_owner'){$script:listenerOwner=9002}
  $probe=if($case -eq 'missing_listener'){{param($Port)}}else{$listeners}
  $refused=$false
  try {Start-OwnedTunnel -StatePath (Join-Path $fixtures ($case+'.json')) -LocalPort 1234 -Start $start -GetProcess $get -StopProcess $stop -Listeners $probe -Wait {} | Out-Null} catch {$refused=$true}
  Assert-True ($refused -and $script:stopped.Count -eq 1 -and -not $script:current) "Unsafe readiness accepted: $case"
}
$proof=@{status='pass';assertions=$script:assertions;ssh_calls=0;server_config_reads=0;real_processes_created=0;cases=@('post_create_failure_receipt_and_cleanup','post_create_reused_pid_refusal','ready_loopback','reused_pid_refusal','wrong_process_name_refusal','public_listener','wrong_listener_owner','missing_listener')}
[IO.File]::WriteAllText((Join-Path (Split-Path $PSScriptRoot) 'tunnel-lifecycle-test-proof.json'),(ConvertTo-Json -InputObject $proof -Depth 5))
Write-Output "PASS mocked tunnel lifecycle: $($script:assertions) assertions; zero SSH/config reads or real processes"
