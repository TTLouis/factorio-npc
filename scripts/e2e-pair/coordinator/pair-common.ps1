$ErrorActionPreference='Stop'
function Read-Pair { Get-Content (Join-Path $PSScriptRoot 'pair.json') -Raw|ConvertFrom-Json -DateKind String }
function Assert-PairFrozen {
  foreach($e in (Get-Content (Join-Path $PSScriptRoot 'pair-manifest.json') -Raw|ConvertFrom-Json)) {
    if((Get-FileHash (Join-Path $PSScriptRoot $e.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $e.sha256){throw "Frozen pair input changed: $($e.path)"}
  }
}
function Pair-DockerInventory([string[]]$Arguments) {
  $rows=@(& docker @Arguments)
  if($LASTEXITCODE -ne 0){throw 'Docker inventory failed; cleanup unverified'}
  return $rows
}
function Read-QuotaDecision($Pair) {
  $quotaFile=Join-Path $PSScriptRoot 'quota-latest.json'
  if(-not(Test-Path $quotaFile)){return 'shared_quota_evidence_unavailable'}
  try {$q=Get-Content $quotaFile -Raw|ConvertFrom-Json} catch {return 'shared_quota_evidence_unavailable'}
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($q.pairId -ne $Pair.pairId -or $q.source -ne 'get_usage_limits' -or $q.observedBy -ne 'parent:/root' -or $q.matchingWeeklyWindows -ne 1 -or $q.windowDurationMins -ne 10080 -or $null -eq $q.remainingPercent -or $q.remainingPercent -lt 0 -or $q.remainingPercent -gt 100 -or $null -eq $q.observedAt -or $now -lt $q.observedAt){return 'shared_quota_evidence_unavailable'}
  if($now-$q.observedAt -gt $Pair.sharedQuota.staleAfterMs){return 'shared_quota_evidence_stale'}
  if($q.remainingPercent -le $Pair.sharedQuota.stopRemainingPercent){return 'stop_both_shared_quota_floor'}
  return 'continue'
}
function Write-LaneStop($Lane,[string]$Reason,[string]$PeerRunId='',[string]$PeerAcceptanceSha256='') {
  $root=Join-Path $PSScriptRoot $Lane.id
  $identityFile=Join-Path $root 'data/logs/e2e-trial-identity.json'
  if(-not(Test-Path $identityFile)) {
    # Pre-admission stops use a distinct marker read before the first starter/goal.
    [IO.File]::WriteAllText((Join-Path $root 'stop-before-admission'),$Reason)
    return
  }
  $identity=Get-Content $identityFile -Raw|ConvertFrom-Json
  if($identity.run_id -ne $Lane.runId -or -not $identity.goal_id -or -not $identity.actor_id){throw 'Lane stop identity mismatch'}
  $request=@{runId=$Lane.runId;goalId=$identity.goal_id;actorId=$identity.actor_id;reason=$Reason;peerRunId=$PeerRunId;peerAcceptanceSha256=$PeerAcceptanceSha256;at=[DateTime]::UtcNow.ToString('o')}
  $file=Join-Path $root 'operator-stop-request.json'
  if(Test-Path $file){$prior=Get-Content $file -Raw|ConvertFrom-Json;if($prior.reason -ne $Reason){return}}
  $temp=$file+'.new'
  [IO.File]::WriteAllText($temp,($request|ConvertTo-Json))
  Move-Item -LiteralPath $temp -Destination $file -Force
}
function Emergency-LaneStop($Lane) {
  $root=Join-Path $PSScriptRoot $Lane.id
  if(-not(Test-Path (Join-Path $root 'live-container.cid'))){return}
  $cid=(Get-Content (Join-Path $root 'live-container.cid') -Raw).Trim()
  if(-not @(Pair-DockerInventory @('ps','-aq','--no-trunc','--filter',"id=$cid")).Count){return}
  $raw=& docker inspect --format '{{json .}}' $cid
  if($LASTEXITCODE -ne 0){throw 'Cannot inspect emergency target'}
  $owned=$raw|ConvertFrom-Json
  $pair=Read-Pair
  if($owned.Config.Labels.'owner.run' -ne $Lane.runId -or $owned.Image -ne $pair.imageId){throw 'Emergency container identity mismatch'}
  $node=(Get-Content (Join-Path $root 'deployed-node-path.txt') -Raw).Trim()
  if($node -notmatch '^/opt/sgluna/\.sgluna/releases/[A-Za-z0-9._-]+/node/bin/node$'){throw 'Emergency node path mismatch'}
  & docker exec $cid $node /e2e/emergency-terminal.mjs *> (Join-Path $root 'coordinator-emergency-stop.log')
  Set-Content (Join-Path $root 'coordinator-emergency-stop.exit') $LASTEXITCODE
  if($LASTEXITCODE -ne 0){throw 'Emergency stop/save incomplete; evidence retained'}
}
function Invoke-LaneSupervisorStop($Lane) {
  $root=Join-Path $PSScriptRoot $Lane.id
  if(-not(Test-Path (Join-Path $root 'operator-stop-request.json'))){return $false}
  $cid=(Get-Content (Join-Path $root 'live-container.cid') -Raw).Trim()
  if(-not @(Pair-DockerInventory @('ps','-aq','--no-trunc','--filter',"id=$cid")).Count){return $true}
  $raw=& docker inspect --format '{{json .}}' $cid
  if($LASTEXITCODE -ne 0){throw 'Cannot inspect supervisor target'}
  $owned=$raw|ConvertFrom-Json
  $pair=Read-Pair
  if($owned.Config.Labels.'owner.run' -ne $Lane.runId -or $owned.Image -ne $pair.imageId){throw 'Supervisor container identity mismatch'}
  $node=(Get-Content (Join-Path $root 'deployed-node-path.txt') -Raw).Trim()
  if($node -notmatch '^/opt/sgluna/\.sgluna/releases/[A-Za-z0-9._-]+/node/bin/node$'){throw 'Supervisor node path mismatch'}
  & docker exec $cid $node /e2e/trial-supervisor-stop.mjs $Lane.runId *> (Join-Path $root 'external-operator-stop.log')
  Set-Content (Join-Path $root 'external-operator-stop.exit') $LASTEXITCODE
  if($LASTEXITCODE -ne 0){throw 'External cancellation failed; runner marker remains set'}
  return $true
}
