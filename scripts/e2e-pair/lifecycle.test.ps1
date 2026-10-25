param([Parameter(Mandatory=$true)][string]$Fixture)
$ErrorActionPreference='Stop'
$checks=0
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$script:checks++}
$pair=Get-Content (Join-Path $Fixture 'pair.json') -Raw|ConvertFrom-Json
. (Join-Path $Fixture 'pair-common.ps1')
# Dot sourcing uses the function-defining script's path, matching real use.
# Test the actual quota reader and lane stop writer without providers or Docker.
$root=$Fixture
$quota=@{pairId=$pair.pairId;source='get_usage_limits';observedBy='parent:/root';matchingWeeklyWindows=1;windowDurationMins=10080;remainingPercent=20;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
$quota|ConvertTo-Json|Set-Content (Join-Path $root 'quota-latest.json')
Check ((Read-QuotaDecision $pair) -eq 'continue') 'Fresh global receipt rejected'
$quota.observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-180001
$quota|ConvertTo-Json|Set-Content (Join-Path $root 'quota-latest.json')
Check ((Read-QuotaDecision $pair) -eq 'shared_quota_evidence_stale') 'Staleness confused with floor'
$quota.observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$quota.remainingPercent=7
$quota|ConvertTo-Json|Set-Content (Join-Path $root 'quota-latest.json')
Check ((Read-QuotaDecision $pair) -eq 'stop_both_shared_quota_floor') 'Shared floor not detected'
$quota.matchingWeeklyWindows=2
$quota|ConvertTo-Json|Set-Content (Join-Path $root 'quota-latest.json')
Check ((Read-QuotaDecision $pair) -eq 'shared_quota_evidence_unavailable') 'Ambiguous weekly windows accepted'
foreach($lane in $pair.lanes) {
  $identity=@{run_id=$lane.runId;actor_id=42;goal_id=('goal_'+$lane.id)}
  $identity|ConvertTo-Json|Set-Content (Join-Path $root ($lane.id+'/data/logs/e2e-trial-identity.json'))
  Write-LaneStop $lane 'shared_quota_evidence_stale'
  $request=Get-Content (Join-Path $root ($lane.id+'/operator-stop-request.json')) -Raw|ConvertFrom-Json
  Check ($request.runId -eq $lane.runId -and $request.goalId -eq ('goal_'+$lane.id) -and $request.actorId -eq 42 -and $request.reason -eq 'shared_quota_evidence_stale') 'Cross-lane stop identity leaked'
}

# Parse every generated PowerShell entry point without executing live commands.
foreach($file in (Get-ChildItem $Fixture -Recurse -Filter '*.ps1')) {
  $tokens=$null;$errors=$null
  $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
  Check ($errors.Count -eq 0) ('PowerShell syntax failed: '+$file.FullName+': '+($errors -join '; '))
}

# Execute real lane cleanup with a Docker mock. B is represented as running;
# querying A must never query/remove B's image, process or containers.
$global:pairedKitDockerCalls=[Collections.Generic.List[string]]::new()
function global:docker {
  $line=$args -join ' ';$global:pairedKitDockerCalls.Add($line)
  $global:LASTEXITCODE=0
  if($line -like '*red-automation-20261025aw-b*'){throw 'Lane A touched lane B'}
  if($line -like '*image*' -or $line -like '*ancestor*'){throw 'Lane cleanup touched shared image'}
}
& (Join-Path $Fixture 'a/finish-cleanup.ps1')
$proof=Get-Content (Join-Path $Fixture 'a/cleanup-proof.json') -Raw|ConvertFrom-Json
Check ($proof.cleanupVerified -eq $true) 'A cleanup failed with B running'
Check ($global:pairedKitDockerCalls.Count -eq 4) 'Unexpected lane cleanup commands'

# Drive the actual wrapper through a runner exception and failed emergency
# confirmation. Its finally path must tear down only A and record failure.
Set-Content (Join-Path $Fixture 'a/live-container.cid') ('a'*64)
Set-Content (Join-Path $Fixture 'a/deployed-node-path.txt') '/opt/sgluna/.sgluna/releases/fixture/node/bin/node'
Set-Content (Join-Path $Fixture 'a/preflight-ready.json') '{"ready":true}'
$global:pairedKitMockPair=$pair
function global:docker {
  $line=$args -join ' ';$global:pairedKitDockerCalls.Add($line);$global:LASTEXITCODE=0
  if($line -like '*red-automation-20261025aw-b*'){throw 'Failing A wrapper touched B'}
  if($line -like '*image rm*' -or $line -like '*ancestor=*'){throw 'Failing lane touched shared image'}
  if($line -like 'container inspect*') {return (@{Id=('a'*64);Image=$global:pairedKitMockPair.imageId;Config=@{Labels=@{'owner.run'=$global:pairedKitMockPair.lanes[0].runId}}}|ConvertTo-Json -Depth 6 -Compress)}
  if($line -like '*cat /opt/sgluna/SOURCE_SHA'){return $global:pairedKitMockPair.candidate}
  if($line -like '*/e2e/run-live.mjs --go' -or $line -like '*/e2e/emergency-terminal.mjs'){$global:LASTEXITCODE=1}
}
& (Join-Path $Fixture 'a/run-and-clean.ps1') -Candidate $pair.candidate
Check ($LASTEXITCODE -eq 1) 'Injected runner/emergency failure lost failure status'
$finished=Get-Content (Join-Path $Fixture 'a/wrapper-finished.json') -Raw|ConvertFrom-Json
Check ($finished.failed -eq $true -and $finished.runId -eq $pair.lanes[0].runId) 'Failed wrapper claimed a pass or mixed lane identity'
Check (@($global:pairedKitDockerCalls|Where-Object {$_ -like '*compose *-p red-automation-20261025aw-a*down --volumes'}).Count -eq 1) 'Runner exception did not execute exact lane compose cleanup'
Check (Test-Path (Join-Path $Fixture 'a/emergency-failure.txt')) 'Missing stop/save failure evidence'
Check (-not(Test-Path (Join-Path $Fixture 'b/wrapper-finished.json'))) 'A failure advanced B lifecycle'

# Pair image teardown refuses to run while sibling cleanup is unfinished.
@{pairId=$pair.pairId;imageId=$pair.imageId;imageTag=$pair.imageTag;tagInitiallyAbsent=$true}|ConvertTo-Json|Set-Content (Join-Path $Fixture 'image-capability.json')
$failed=$false
try { & (Join-Path $Fixture 'finish-pair.ps1') } catch {$failed=$true}
Check $failed 'Pair removed image before B completed'
Check (@($global:pairedKitDockerCalls|Where-Object {$_ -like '*image rm*'}).Count -eq 0) 'Pair deleted image while B active'

# Inventory failure must not claim absence. It writes no successful replacement.
function global:docker { $global:LASTEXITCODE=1 }
$failed=$false
try { & (Join-Path $Fixture 'b/finish-cleanup.ps1') } catch {$failed=$true}
Check $failed 'Docker inventory failure accepted as absence'
Check (-not(Test-Path (Join-Path $Fixture 'b/cleanup-proof.json'))) 'Failed cleanup claimed success'

# With both exact lanes cleaned, the actual pair finalizer removes only the
# capability-owned unique tag, never an image ID or another session's alias.
@{runId=$pair.lanes[1].runId;cleanupVerified=$true}|ConvertTo-Json|Set-Content (Join-Path $Fixture 'b/cleanup-proof.json')
$global:pairedKitImageRemoved=$false
function global:docker {
  $line=$args -join ' ';$global:pairedKitDockerCalls.Add($line);$global:LASTEXITCODE=0
  if($line -like 'image ls *') {if(-not $global:pairedKitImageRemoved){return $global:pairedKitMockPair.imageId};return}
  if($line -like 'image rm *') {
    if($line -ne ('image rm '+$global:pairedKitMockPair.imageTag)){throw 'Wrong image removal target'}
    $global:pairedKitImageRemoved=$true
    return
  }
  if($line -like '*ancestor=*' -or $line -like '*prune*'){throw 'Invalid global cleanup guard'}
}
& (Join-Path $Fixture 'finish-pair.ps1')
Check $global:pairedKitImageRemoved 'Pair unique tag was not removed after both lanes finished'
Check (Test-Path (Join-Path $Fixture 'pair-cleanup-proof.json')) 'Pair verified cleanup artifact missing'
Remove-Item function:global:docker
Remove-Variable pairedKitDockerCalls -Scope Global
Remove-Variable pairedKitMockPair -Scope Global
Remove-Variable pairedKitImageRemoved -Scope Global
Write-Output "PASS $checks deterministic lifecycle/AST checks; no live calls/resources"
