$ErrorActionPreference='Stop'
function Docker-Inventory([string[]]$DockerArgs) {
  $rows=@(& docker @DockerArgs)
  if($LASTEXITCODE -ne 0){throw 'Docker inventory failed; absence unverified'}
  return $rows
}
function Assert-FrozenHelpers {
  foreach($e in (Get-Content (Join-Path $PSScriptRoot 'helper-manifest.json') -Raw|ConvertFrom-Json)) {
    if((Get-FileHash (Join-Path $PSScriptRoot $e.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $e.sha256){throw "Frozen helper changed: $($e.path)"}
  }
}
function Assert-OwnedContainer([string]$Id) {
  $raw=& docker container inspect --format '{{json .}}' $Id
  if($LASTEXITCODE -ne 0){throw 'Cannot inspect owned container'}
  $item=$raw|ConvertFrom-Json
  if($item.Config.Labels.'owner.run' -ne '@@RUN_ID@@' -or $item.Image -ne '@@IMAGE_ID@@'){throw 'Container ownership/image changed'}
  return $item
}
function Invoke-OwnedProof([string]$Name,[string]$Output,[string[]]$Arguments) {
  if($Name -notlike '@@RESOURCE_PREFIX@@-*'){throw 'Proof resource outside lane scope'}
  $cidFile=Join-Path $PSScriptRoot ($Output+'.cid')
  if(Test-Path $cidFile){throw 'Existing proof identity; inspect before retry'}
  try {
    & docker run --name $Name --cidfile $cidFile --rm --pull never --network none --label owner.run=@@RUN_ID@@ @Arguments *> (Join-Path $PSScriptRoot ($Output+'.log'))
    $code=$LASTEXITCODE
    Set-Content (Join-Path $PSScriptRoot ($Output+'.exit')) $code
    if($code -ne 0){throw "Offline proof failed: $Name"}
  } finally {
    if(Test-Path $cidFile) {
      $cid=(Get-Content $cidFile -Raw).Trim()
      if($cid -notmatch '^[a-f0-9]{64}$'){throw 'Invalid proof container receipt'}
      if(@(Docker-Inventory @('ps','-aq','--no-trunc','--filter',"id=$cid")).Count) {
        $raw=& docker inspect --format '{{json .Config.Labels}}' $cid
        if($LASTEXITCODE -ne 0 -or ($raw|ConvertFrom-Json).'owner.run' -ne '@@RUN_ID@@'){throw 'Proof container ownership changed'}
        & docker rm -f $cid
        if($LASTEXITCODE -ne 0){throw "Cleanup failed; recovery docker rm -f $cid"}
      }
      if(@(Docker-Inventory @('ps','-aq','--no-trunc','--filter',"id=$cid")).Count){throw 'Owned proof container remains'}
    }
  }
}
