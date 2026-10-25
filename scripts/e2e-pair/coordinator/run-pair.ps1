param([switch]$StopPeerAfterVerifiedSuccess)
. (Join-Path $PSScriptRoot 'pair-common.ps1')
$pair=Read-Pair
$workers=@{}
$completed=$false
$failed=$false
if((Test-Path (Join-Path $PSScriptRoot 'pair-launch-once.json')) -or (Test-Path (Join-Path $PSScriptRoot 'pair-launch-attempt.json'))){throw 'Pair lifecycle already claimed; duplicate has no cleanup authority'}
$controller=Enter-PairController $pair 'launch'
$ownsPrepared=$false
try {
  Assert-PreparedOwnership $pair
  $ownsPrepared=$true
  $attempt=Join-Path $PSScriptRoot 'pair-launch-attempt.json'
  $handle=[IO.File]::Open($attempt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{pairId=$pair.pairId;controllerToken=$controller.token;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json));$handle.Write($bytes,0,$bytes.Length);$handle.Flush($true)}finally{$handle.Dispose()}
  Assert-PairFrozen
  if((Read-QuotaDecision $pair) -ne 'continue'){throw 'Fresh shared-account quota above the stop floor required'}
  foreach($lane in $pair.lanes){if(-not(Test-Path (Join-Path $PSScriptRoot ($lane.id+'/preflight-ready.json')))){throw 'Both independent preflights must pass before paired launch'}}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pair-launch-once.json'),(@{pairId=$pair.pairId;candidate=$pair.candidate;startedAt=[DateTime]::UtcNow.ToString('o');stopPeerAfterVerifiedSuccess=[bool]$StopPeerAfterVerifiedSuccess}|ConvertTo-Json))
  foreach($lane in $pair.lanes) {
    $root=Join-Path $PSScriptRoot $lane.id
    $script=Join-Path $root 'run-and-clean.ps1'
    $p=Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoProfile','-File',('"'+$script+'"'),'-Candidate',$pair.candidate) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'wrapper-stdout.log') -RedirectStandardError (Join-Path $root 'wrapper-stderr.log')
    $workers[$lane.id]=@{process=$p;startedTicks=$p.StartTime.ToUniversalTime().Ticks;script=$script}
    [IO.File]::WriteAllText((Join-Path $root 'wrapper-process.json'),(@{pid=$p.Id;startedTicks=$p.StartTime.ToUniversalTime().Ticks;script=$script;runId=$lane.runId}|ConvertTo-Json))
  }
  $peerStopIssued=$false
  $quotaStops=@{}
  while(@($workers.Values|Where-Object {-not $_.process.HasExited}).Count) {
    $quotaDecision=Read-QuotaDecision $pair
    if($quotaDecision -ne 'continue') {
      foreach($lane in $pair.lanes) {
        $reason=if($quotaDecision -eq 'stop_both_shared_quota_floor'){'weekly_remaining_floor_reached'}else{$quotaDecision}
        Write-LaneStop $lane $reason
        if(-not $quotaStops[$lane.id]){$quotaStops[$lane.id]=Invoke-LaneSupervisorStop $lane}
      }
    }
    if($StopPeerAfterVerifiedSuccess -and -not $peerStopIssued) {
      foreach($lane in $pair.lanes) {
        if(-not $workers[$lane.id].process.HasExited){continue}
        # Exit zero is insufficient. Recompute native throughput acceptance.
        & node (Join-Path $PSScriptRoot 'verify-peer-success.mjs') $lane.id *> (Join-Path $PSScriptRoot ($lane.id+'/peer-acceptance-check.log'))
        if($LASTEXITCODE -eq 0) {
          $peer=$pair.lanes|Where-Object id -NE $lane.id
          & (Join-Path $PSScriptRoot 'request-stop.ps1') -Lane $peer.id -Reason canceled_after_peer_verified_success
          $peerStopIssued=$true
          break
        }
      }
    }
    # One lane's gameplay failure is independent; its sibling keeps running.
    Start-Sleep -Seconds 2
  }
  foreach($w in $workers.Values){$w.process.WaitForExit();if($w.process.ExitCode -ne 0){$failed=$true}}
  $completed=$true
} finally {
  try {
  if($ownsPrepared -and -not $completed) {
    $failed=$true
    foreach($lane in $pair.lanes){try{Write-LaneStop $lane 'pair_supervisor_failure';$null=Invoke-LaneSupervisorStop $lane}catch{[IO.File]::WriteAllText((Join-Path $PSScriptRoot ($lane.id+'/external-cancel-failure.txt')),[string]$_)}}
    $deadline=[DateTime]::UtcNow.AddSeconds(240)
    while(@($workers.Values|Where-Object {-not $_.process.HasExited}).Count -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Seconds 2}
    foreach($lane in $pair.lanes) {
      try {
        $w=$workers[$lane.id]
        if($w -and -not $w.process.HasExited) {
          Emergency-LaneStop $lane
          # Exact owned wrapper identity only; no broad process-name kill.
          $current=Get-Process -Id $w.process.Id -ErrorAction SilentlyContinue
          if($current -and $current.StartTime.ToUniversalTime().Ticks -ne $w.startedTicks){throw 'Wrapper PID changed; refusing stop'}
          if($current){Stop-Process -InputObject $current -ErrorAction Stop;$current.WaitForExit(5000)|Out-Null}
        }
      } catch { [IO.File]::WriteAllText((Join-Path $PSScriptRoot ($lane.id+'/coordinator-failure.txt')),[string]$_) }
      try {
        & (Join-Path $PSScriptRoot ($lane.id+'/stack.ps1')) -Action down -Candidate $pair.candidate *> (Join-Path $PSScriptRoot ($lane.id+'/coordinator-down.log'))
      } catch {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot ($lane.id+'/coordinator-down-failure.txt')),[string]$_)
      } finally {
        try { & (Join-Path $PSScriptRoot ($lane.id+'/finish-cleanup.ps1')) *> (Join-Path $PSScriptRoot ($lane.id+'/coordinator-cleanup.log')) }
        catch { [IO.File]::WriteAllText((Join-Path $PSScriptRoot ($lane.id+'/coordinator-cleanup-failure.txt')),[string]$_) }
      }
      # Even if emergency proof failed, no owned wrapper may remain after the
      # exact lane's container teardown. A replaced PID is never killed.
      try {
        $w=$workers[$lane.id]
        if($w -and -not $w.process.HasExited) {
          $current=Get-Process -Id $w.process.Id -ErrorAction SilentlyContinue
          if($current -and $current.StartTime.ToUniversalTime().Ticks -ne $w.startedTicks){throw 'Wrapper PID changed; refusing stop'}
          if($current){Stop-Process -InputObject $current -ErrorAction Stop;$current.WaitForExit(5000)|Out-Null}
        }
      } catch { [IO.File]::WriteAllText((Join-Path $PSScriptRoot ($lane.id+'/wrapper-cleanup-failure.txt')),[string]$_) }
    }
  }
  if($ownsPrepared) {
  try { & (Join-Path $PSScriptRoot 'finish-pair.ps1') *> (Join-Path $PSScriptRoot 'pair-cleanup.log') }
  catch { $failed=$true;[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pair-cleanup-failure.txt'),[string]$_) }
  & node (Join-Path $PSScriptRoot 'summarize-pair.mjs') *> (Join-Path $PSScriptRoot 'combined-call-index.log')
  if($LASTEXITCODE -ne 0){$failed=$true}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pair-finished.json'),(@{pairId=$pair.pairId;at=[DateTime]::UtcNow.ToString('o');wrapperFailure=$failed;gameplayResults='Read each lane result independently; wrapper status is not gameplay acceptance'}|ConvertTo-Json))
  }
  } finally {Exit-PairController $controller}
}
if($failed){exit 1}
