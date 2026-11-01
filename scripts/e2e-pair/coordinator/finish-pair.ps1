. (Join-Path $PSScriptRoot 'pair-common.ps1')
Assert-PairFrozen
$pair=Read-Pair
$capFile=Join-Path $PSScriptRoot 'image-capability.json'
if(-not(Test-Path $capFile)){throw 'Pair-owned unique image capability absent; retain image'}
$cap=Get-Content $capFile -Raw|ConvertFrom-Json
if($cap.pairId -ne $pair.pairId -or $cap.imageId -ne $pair.imageId -or $cap.imageTag -ne $pair.imageTag -or $cap.tagInitiallyAbsent -ne $true){throw 'Pair-owned image capability mismatch; retain image'}
foreach($lane in $pair.lanes) {
  $proof=Get-Content (Join-Path $PSScriptRoot ($lane.id+'/cleanup-proof.json')) -Raw|ConvertFrom-Json
  if($proof.runId -ne $lane.runId -or $proof.cleanupVerified -ne $true){throw 'Both lane cleanups required; retain image'}
  foreach($query in @(
    @('ps','-aq','--filter',('label=owner.run='+$lane.runId)),
    @('ps','-aq','--filter',('label=com.docker.compose.project='+$lane.project)),
    @('network','ls','-q','--filter',('label=com.docker.compose.project='+$lane.project)),
    @('volume','ls','-q','--filter',('label=com.docker.compose.project='+$lane.project)))) {
    if(@(Pair-DockerInventory $query).Count){throw 'Pair resources remain; retain image'}
  }
  $workerFile=Join-Path $PSScriptRoot ($lane.id+'/wrapper-process.json')
  if(Test-Path $workerFile) {
    $w=Get-Content $workerFile -Raw|ConvertFrom-Json
    $p=Get-Process -Id $w.pid -ErrorAction SilentlyContinue
    if($p -and $p.StartTime.ToUniversalTime().Ticks -eq $w.startedTicks){throw 'Owned wrapper remains; retain image'}
  }
}
$ids=@(Pair-DockerInventory @('image','ls','--quiet','--no-trunc',$pair.imageTag))
if($ids.Count) {
  if($ids.Count -ne 1 -or $ids[0].Trim() -ne $pair.imageId){throw 'Pair image tag changed; refusing deletion'}
  # No ancestor guard: two lanes intentionally share an image. Their owned
  # resources are checked above. Remove only our unique tag, never force/ID.
  & docker image rm $pair.imageTag
  if($LASTEXITCODE -ne 0){throw 'Unique pair tag removal failed; image retained'}
}
if(@(Pair-DockerInventory @('image','ls','--quiet','--no-trunc',$pair.imageTag)).Count){throw 'Pair image tag remains'}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pair-cleanup-proof.json'),(@{pairId=$pair.pairId;bothLaneCleanupVerified=$true;uniqueTagRemoved=$true;sharedImageIdentitiesUntouched=$true;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json))
