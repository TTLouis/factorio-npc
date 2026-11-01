$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-resources.ps1')
Assert-FrozenHelpers
if(Test-Path (Join-Path $PSScriptRoot 'world-created.json')){throw 'Fresh map already created; no automatic retry'}
if(@(Get-ChildItem (Join-Path $PSScriptRoot 'data/saves') -Force).Count){throw 'Data directory is not cold'}
Invoke-OwnedProof -Name '@@RESOURCE_PREFIX@@-world-create' -Output 'world-create' -Arguments @('--mount',"type=bind,source=$PSScriptRoot/data,target=/data",'--mount',"type=bind,source=$PSScriptRoot,target=/proof",'--entrypoint','bash','@@IMAGE_ID@@','/proof/create-world.sh')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'world-created.json'),(@{runId='@@RUN_ID@@';seed=@@SEED@@;source='@@CANDIDATE@@';image='@@IMAGE_ID@@';method='native --create --map-gen-settings';native_seed_verification='required at preflight and immediately before starter'}|ConvertTo-Json))
