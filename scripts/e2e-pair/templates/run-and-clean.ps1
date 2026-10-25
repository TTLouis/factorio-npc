param([Parameter(Mandatory=$true)][string]$Candidate)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-resources.ps1')
$failed=$false
$node=$null
$cid=$null
function Verify-Save([switch]$Emergency) {
  & (Join-Path $PSScriptRoot 'verify-final-save.ps1') -Emergency:$Emergency *> (Join-Path $PSScriptRoot ('verify-save-'+$Emergency+'.log'))
  $proof=Join-Path $PSScriptRoot $(if($Emergency){'native-save-load-emergency'}else{'native-save-load'})
  if($Emergency){
    New-Item -ItemType Directory $proof -Force|Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'native-save-load/run_native_load.sh') $proof
    Copy-Item (Join-Path $PSScriptRoot 'native-save-load/verify_active_mod.mjs') $proof
  }
  $suffix=if($Emergency){'native-load-emergency'}else{'native-load'}
  Invoke-OwnedProof -Name ('@@RESOURCE_PREFIX@@-'+$suffix) -Output $suffix -Arguments @('--mount',"type=bind,source=$PSScriptRoot,target=/input,readonly",'--mount',"type=bind,source=$proof,target=/proof",'--entrypoint','bash','@@IMAGE_ID@@','/proof/run_native_load.sh')
}
try {
  if($Candidate -ne '@@CANDIDATE@@'){throw 'Candidate differs from frozen lane'}
  Assert-FrozenHelpers
  if(-not(Test-Path (Join-Path $PSScriptRoot 'preflight-ready.json'))){throw 'Independent lane preflight required'}
  if(Test-Path (Join-Path $PSScriptRoot 'launch-once.json')){throw 'One trial per lane; no resume/retry'}
  $cid=(Get-Content (Join-Path $PSScriptRoot 'live-container.cid') -Raw).Trim()
  $null=Assert-OwnedContainer $cid
  $node=(Get-Content (Join-Path $PSScriptRoot 'deployed-node-path.txt') -Raw).Trim()
  if($node -notmatch '^/opt/sgluna/\.sgluna/releases/[A-Za-z0-9._-]+/node/bin/node$'){throw 'Invalid deployed node path'}
  $source=(& docker exec $cid cat /opt/sgluna/SOURCE_SHA).Trim()
  if($LASTEXITCODE -ne 0 -or $source -ne $Candidate){throw 'Deployed source mismatch'}
  & docker exec $cid $node /e2e/prelaunch-cold-check.mjs *> (Join-Path $PSScriptRoot 'prelaunch-immediate.log')
  if($LASTEXITCODE -ne 0){throw 'Immediate cold/seed proof failed'}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'launch-once.json'),(@{runId='@@RUN_ID@@';at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json))
  & docker exec $cid $node /e2e/run-live.mjs --go *> (Join-Path $PSScriptRoot 'run-live.log')
  Set-Content (Join-Path $PSScriptRoot 'run-live-exit.txt') $LASTEXITCODE
  if($LASTEXITCODE -ne 0){throw 'Runner failed; emergency strict stop required'}
  Verify-Save
} catch {
  $failed=$true
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'wrapper-failure.txt'),[string]$_)
  if($node -and $cid) {
    try {
      $null=Assert-OwnedContainer $cid
      & docker exec $cid $node /e2e/emergency-terminal.mjs *> (Join-Path $PSScriptRoot 'emergency-stop.log')
      Set-Content (Join-Path $PSScriptRoot 'emergency-stop.exit') $LASTEXITCODE
      if($LASTEXITCODE -ne 0){throw 'Emergency stop/save proof incomplete'}
      Verify-Save -Emergency
    } catch { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'emergency-failure.txt'),[string]$_) }
  }
} finally {
  try {
    if($cid){ & docker logs $cid *> (Join-Path $PSScriptRoot 'stack-container.log') }
    & (Join-Path $PSScriptRoot 'stack.ps1') -Action down -Candidate '@@CANDIDATE@@' *> (Join-Path $PSScriptRoot 'stack-down.log')
  } catch { $failed=$true;[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'down-failure.txt'),[string]$_) }
  try { & (Join-Path $PSScriptRoot 'finish-cleanup.ps1') *> (Join-Path $PSScriptRoot 'finish-cleanup.log') }
  catch { $failed=$true;[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'cleanup-failure.txt'),[string]$_) }
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'wrapper-finished.json'),(@{runId='@@RUN_ID@@';at=[DateTime]::UtcNow.ToString('o');failed=$failed}|ConvertTo-Json))
}
if($failed){exit 1}
