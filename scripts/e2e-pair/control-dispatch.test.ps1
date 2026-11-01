param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Lane,[Parameter(Mandatory=$true)][string]$Reason,[Parameter(Mandatory=$true)][string]$Kit)
$ErrorActionPreference='Stop'
. (Join-Path $Root 'pair-common.ps1')
$p=Read-Pair;$target=$p.lanes|Where-Object id -EQ $Lane
if($Reason -ne 'owner_canceled') {
  $decision=Read-QuotaDecision $p
  $Reason=if($decision -eq 'stop_both_shared_quota_floor'){'weekly_remaining_floor_reached'}else{$decision}
}
$global:controlFixturePair=$p;$global:controlFixtureLane=$target;$global:controlFixtureRoot=$Root;$global:controlFixtureKit=$Kit
function global:docker {
  $line=$args -join ' ';$global:LASTEXITCODE=0
  if($line -like 'ps -aq*'){return ('a'*64)}
  if($line -like 'inspect *'){return (@{Image=$global:controlFixturePair.imageId;Config=@{Labels=@{'owner.run'=$global:controlFixtureLane.runId}}}|ConvertTo-Json -Depth 6 -Compress)}
  if($line -like 'exec * /e2e/trial-supervisor-stop.mjs *') {
    & node (Join-Path $global:controlFixtureKit 'control-dispatch-fixture.mjs') (Join-Path $global:controlFixtureRoot $global:controlFixtureLane.id) $global:controlFixtureLane.runId
    return
  }
  throw 'Unexpected control transport; no world observer permitted'
}
Write-LaneStop $target $Reason
$sent=Invoke-LaneSupervisorStop $target
if(-not $sent){throw 'Immediate launch-phase cancellation did not dispatch'}
