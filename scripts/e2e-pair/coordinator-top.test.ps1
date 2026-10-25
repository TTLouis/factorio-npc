param([Parameter(Mandatory=$true)][string]$Fixture)
$ErrorActionPreference='Stop'
$checks=0
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
$cases=Join-Path (Split-Path $Fixture) 'coordinator-top-cases';New-Item -ItemType Directory $cases|Out-Null
function Case([string]$Name) {
  $root=Join-Path $cases $Name;Copy-Item -LiteralPath $Fixture -Destination $root -Recurse
  $p=Get-Content (Join-Path $root 'pair.json') -Raw|ConvertFrom-Json
  foreach($lane in $p.lanes) {
    # Only external resource boundaries are substituted; run-pair/prepare-pair,
    # controller ownership and the actual lane finalizer remain unchanged.
    $stack=@'
param($Action,$Candidate)
$root=Split-Path $PSScriptRoot
Add-Content (Join-Path $root 'boundary-calls.txt') ((Split-Path $PSScriptRoot -Leaf)+':stack:'+ $Action)
if((Split-Path $PSScriptRoot -Leaf) -eq 'a' -and (Test-Path (Join-Path $root 'fail-a-down'))){throw 'Injected A teardown failure'}
'@
    Set-Content (Join-Path $root ($lane.id+'/stack.ps1')) $stack
    Set-Content (Join-Path $root ($lane.id+'/preflight-ready.json')) '{"ready":true}'
    Set-Content (Join-Path $root ($lane.id+'/analysis/recorder-process.json')) ('{"pid":'+(600000+[int][char]$lane.id)+'}')
    Set-Content (Join-Path $root ($lane.id+'/analysis/stop-recorder.ps1')) 'Add-Content (Join-Path (Split-Path (Split-Path $PSScriptRoot)) "boundary-calls.txt") ((Split-Path (Split-Path $PSScriptRoot) -Leaf)+":recorder-absence-checked")'
    Set-Content (Join-Path $root ($lane.id+'/proxy-tunnel/tunnel-state.json')) (@{PID=(700000+[int][char]$lane.id);LocalPort=$lane.tunnelPort}|ConvertTo-Json)
    Set-Content (Join-Path $root ($lane.id+'/proxy-tunnel/tunnel-lifecycle.ps1')) 'function Stop-OwnedTunnel($State){Add-Content (Join-Path (Split-Path (Split-Path $PSScriptRoot)) "boundary-calls.txt") ((Split-Path (Split-Path $PSScriptRoot) -Leaf)+":tunnel-absence-checked");return @{process_absent=$true;owned_listener_absent=$true}}'
    Set-Content (Join-Path $root ($lane.id+'/prepare-stack.ps1')) 'throw "Injected preparation refusal before any intake"'
  }
  $manifest=Get-Content (Join-Path $root 'pair-manifest.json') -Raw|ConvertFrom-Json
  foreach($e in $manifest){$e.sha256=(Get-FileHash (Join-Path $root $e.path)).Hash.ToLowerInvariant()}
  $manifest|ConvertTo-Json -Depth 6|Set-Content (Join-Path $root 'pair-manifest.json')
  return $root
}
function Prepared([string]$Root) {
  $p=Get-Content (Join-Path $Root 'pair.json') -Raw|ConvertFrom-Json
  @{pairId=$p.pairId;candidate=$p.candidate;imageId=$p.imageId;lanes=@($p.lanes|ForEach-Object {@{id=$_.id;runId=$_.runId}})}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $Root 'pair-prepared.json')
}
function Quota([string]$Root,[string]$Mode) {
  if($Mode -eq 'missing'){return}
  $p=Get-Content (Join-Path $Root 'pair.json') -Raw|ConvertFrom-Json
  $q=@{pairId=$p.pairId;source='get_usage_limits';observedBy='parent:/root';matchingWeeklyWindows=1;windowDurationMins=10080;remainingPercent=20;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  if($Mode -eq 'stale'){$q.observedAt-=180001};if($Mode -eq 'floor'){$q.remainingPercent=7}
  $q|ConvertTo-Json|Set-Content (Join-Path $Root 'quota-latest.json')
}
function global:Start-Process {throw 'Refused coordinator must never start a worker/intake'}
function global:docker {Add-Content (Join-Path $global:pairedTopRoot 'boundary-calls.txt') ('docker:'+($args -join ' '));$global:LASTEXITCODE=0}
foreach($mode in @('missing','stale','floor','missing-preflight','first-cleanup-fails')) {
  $root=Case ('launch-'+$mode);$global:pairedTopRoot=$root;Prepared $root;Quota $root $(if($mode -in @('missing-preflight','first-cleanup-fails')){'fresh'}else{$mode})
  if($mode -eq 'missing-preflight'){Remove-Item -LiteralPath (Join-Path $root 'b/preflight-ready.json')}
  if($mode -eq 'first-cleanup-fails'){Set-Content (Join-Path $root 'fail-a-down') 'injected';Remove-Item -LiteralPath (Join-Path $root 'b/preflight-ready.json')}
  $refused=$false;try{& (Join-Path $root 'run-pair.ps1')}catch{$refused=$true}
  Check $refused ('Launch refusal not surfaced: '+$mode)
  $calls=@(Get-Content (Join-Path $root 'boundary-calls.txt') -ErrorAction SilentlyContinue)
  foreach($id in @('a','b')) {
    Check ($calls -contains ($id+':stack:down')) ('Missing lane teardown '+$id+' '+$mode)
    Check ($calls -contains ($id+':recorder-absence-checked')) ('Missing recorder cleanup '+$id)
    Check ($calls -contains ($id+':tunnel-absence-checked')) ('Missing tunnel cleanup '+$id)
    Check (Test-Path (Join-Path $root ($id+'/cleanup-proof.json'))) ('No fresh resource inventory '+$id)
  }
  Check (-not(Test-Path (Join-Path $root 'pair-launch-once.json'))) 'Refusal started a trial'
  Check (Test-Path (Join-Path $root 'pair-cleanup-failure.txt')) 'Missing explicit image capability retention evidence'
  Check (-not(Test-Path (Join-Path $root 'controller.lock'))) 'Refusal leaked controller lock'
}
foreach($mode in @('missing','stale','floor','setup-failure')) {
  $root=Case ('prepare-'+$mode);$global:pairedTopRoot=$root;Quota $root $(if($mode -eq 'setup-failure'){'fresh'}else{$mode})
  $refused=$false;try{& (Join-Path $root 'prepare-pair.ps1')}catch{$refused=$true}
  Check $refused ('Preparation failure missing: '+$mode)
  $calls=Get-Content (Join-Path $root 'boundary-calls.txt')
  Check ($calls -contains 'a:stack:down' -and $calls -contains 'b:stack:down') 'Preparation must attempt both cleanups'
  Check (Test-Path (Join-Path $root 'prepare-pair-failure.json')) 'Preparation did not record retained image/failure boundary'
  Check (-not(Test-Path (Join-Path $root 'controller.lock'))) 'Preparation leaked controller lock'
}
foreach($entry in @('run-pair.ps1','prepare-pair.ps1')) {
  $root=Case ('duplicate-'+$entry.Replace('.ps1',''));$global:pairedTopRoot=$root
  . (Join-Path $root 'pair-common.ps1');$p=Read-Pair
  if($entry -eq 'run-pair.ps1'){Prepared $root}
  $owner=Enter-PairController $p 'existing-active-owner'
  try {
    $refused=$false;try{& (Join-Path $root $entry)}catch{$refused=$true}
    Check $refused 'Duplicate active controller accepted'
    Check (-not(Test-Path (Join-Path $root 'boundary-calls.txt'))) 'Duplicate touched existing owner resources'
    Check ((Get-Content (Join-Path $root 'controller.lock') -Raw|ConvertFrom-Json).token -eq $owner.token) 'Duplicate changed owner capability'
  } finally {Exit-PairController $owner}
}
Remove-Item function:global:docker;Remove-Item function:global:Start-Process;Remove-Variable pairedTopRoot -Scope Global
Write-Output "PASS $checks actual top-level coordinator ownership/refusal checks across 11 scenarios; external resource boundaries mocked"
