param([string]$EvidenceDirectory='')
$ErrorActionPreference='Stop'
$repo=Split-Path (Split-Path $PSScriptRoot)
if(-not $EvidenceDirectory){$EvidenceDirectory=Join-Path $repo ('test-results/paired-kit/attempt-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))}
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
if(Test-Path $evidence){throw 'Evidence directory already exists; keep prior attempt intact'}
New-Item -ItemType Directory $evidence -Force|Out-Null
Write-Output ('Local evidence: '+$evidence)
# Built-in Node only: deterministic freezer/schema and file tests; no host package tools.
& node --test (Join-Path $PSScriptRoot 'pair.test.mjs') *> (Join-Path $evidence 'pair-tests.log')
$code=$LASTEXITCODE;Set-Content (Join-Path $evidence 'pair-tests.exit') $code
if($code -ne 0){throw 'Pair deterministic tests failed; see local log'}
Write-Output 'Pair freezer/schema tests passed.'
& node (Join-Path $PSScriptRoot 'render-fixture.mjs') $repo $evidence *> (Join-Path $evidence 'render-fixture.log')
if($LASTEXITCODE -ne 0){throw 'Offline fixture render failed; existing fixtures are never overwritten'}
$fixture=Join-Path $evidence 'rendered-pair'
& (Get-Command pwsh).Source -NoProfile -File (Join-Path $PSScriptRoot 'lifecycle.test.ps1') -Fixture $fixture *> (Join-Path $evidence 'lifecycle-tests.log')
if($LASTEXITCODE -ne 0){throw 'Deterministic lifecycle mocks/PowerShell syntax failed'}
$testLanes=@(
  @{name='helpers';image='npc-dev';entry='sh';arguments=@('-c','node --test /proof/a/runner-terminal.test.mjs /proof/a/automation-proof.test.mjs /proof/a/provider-contract-preflight.test.mjs /proof/a/protocol3-provider-preflight.test.mjs /proof/a/trial-stop-policy.test.mjs /proof/a/analysis/response-recorder.test.mjs /proof/a/pair-stop.test.mjs /proof/b/automation-proof.test.mjs /proof/b/provider-contract-preflight.test.mjs && for f in /proof/*.mjs /proof/a/*.mjs /proof/b/*.mjs; do node --check "$f" || exit; done')},
  @{name='archive';image='sha256:c23de29f686824ca7598116b07ed0b80697af354edef26c0e0eea20287fb3697';entry='python3';arguments=@('/proof/a/save-archive-check.test.py')}
)
foreach($lane in $testLanes) {
  $scope='paired-kit-'+[guid]::NewGuid().ToString('N').Substring(0,12)+'-'+$lane.name
  $cidFile=Join-Path $evidence ($scope+'.cid')
  @{name=$scope;composeProject=$null;image=$lane.image;network='none';pull='never'}|ConvertTo-Json|Set-Content (Join-Path $evidence ($scope+'.intent.json'))
  Write-Output ('Owned offline container: '+$scope)
  try {
    & docker run --name $scope --cidfile $cidFile --rm --pull never --network none --label owner.test=$scope --mount "type=bind,source=$fixture,target=/proof,readonly" --mount "type=bind,source=$repo/deploy/pterodactyl,target=/candidate/deploy/pterodactyl,readonly" --entrypoint $lane.entry $lane.image @($lane.arguments) *> (Join-Path $evidence ($lane.name+'.log'))
    $code=$LASTEXITCODE;Set-Content (Join-Path $evidence ($lane.name+'.exit')) $code
    if($code -ne 0){throw ('Rendered offline regressions failed: '+$lane.name)}
  } finally {
    if(Test-Path $cidFile) {
      $cid=(Get-Content $cidFile -Raw).Trim()
      if($cid -notmatch '^[a-f0-9]{64}$'){throw 'Invalid offline container receipt'}
      $remaining=@(& docker ps -aq --no-trunc --filter "id=$cid")
      if($LASTEXITCODE -ne 0){throw 'Offline cleanup inventory failed'}
      if($remaining.Count){& docker rm -f $cid;if($LASTEXITCODE -ne 0){throw "Offline cleanup failed: docker rm -f $cid"}}
      $remaining=@(& docker ps -aq --no-trunc --filter "id=$cid")
      if($LASTEXITCODE -ne 0 -or $remaining.Count){throw "Offline cleanup unverified: $cid"}
      @{name=$scope;id=$cid;absenceVerified=$true;network='none';createdImages=0;createdVolumes=0}|ConvertTo-Json|Set-Content (Join-Path $evidence ($scope+'.cleanup.json'))
    }
  }
}
Write-Output 'Rendered helper/archive tests passed; exact owned offline containers absent.'
