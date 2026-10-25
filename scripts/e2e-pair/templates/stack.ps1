param([Parameter(Mandatory=$true)][ValidateSet('up','down')][string]$Action,[Parameter(Mandatory=$true)][string]$Candidate)
$ErrorActionPreference='Stop'
if($Candidate -ne '@@CANDIDATE@@'){throw 'Source differs from frozen candidate'}
$composeInputs=@{
  'frozen-compose/compose.yml'='@@COMPOSE_BASE_SHA@@'
  'frozen-compose/compose.e2e.yml'='@@COMPOSE_E2E_SHA@@'
  'live.compose.yml'='@@LIVE_COMPOSE_SHA@@'
}
foreach($file in $composeInputs.Keys){if((Get-FileHash (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $composeInputs[$file]){throw 'Frozen Compose input changed; refusing mutation'}}
$vars=@('COMPOSE_ENV_FILES','SGLUNA_SOURCE_REF','SGLUNA_DATA_DIR','SGLUNA_RCON_HOST_PORT','SGLUNA_RCON_PORT','SERVER_PORT')
$previous=@{}
foreach($name in $vars){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Push-Location $PSScriptRoot
try {
  # Compose reads the existing configured environment internally; never print it.
  $env:COMPOSE_ENV_FILES='D:/SideProjects/airi-factorio-npc/airi-factorio/.env'
  $env:SGLUNA_SOURCE_REF=$Candidate
  $env:SGLUNA_DATA_DIR=(Join-Path $PSScriptRoot 'data').Replace('\','/')
  $env:SGLUNA_RCON_HOST_PORT='@@RCON_HOST_PORT@@'
  $env:SGLUNA_RCON_PORT='27015'
  $env:SERVER_PORT='@@GAME_PORT@@'
  $argsCompose=@('compose','--project-directory',$PSScriptRoot,'-p','@@PROJECT@@','-f',(Join-Path $PSScriptRoot 'frozen-compose/compose.yml'),'-f',(Join-Path $PSScriptRoot 'frozen-compose/compose.e2e.yml'),'-f',(Join-Path $PSScriptRoot 'live.compose.yml'))
  if($Action -eq 'up') {
    if(-not(Test-Path (Join-Path $PSScriptRoot 'world-created.json'))){throw 'Frozen fresh map creation proof required'}
    & docker @argsCompose up -d --no-build --pull never sgluna-factorio
  } else { & docker @argsCompose down --volumes }
  if($LASTEXITCODE -ne 0){throw "Isolated stack $Action failed"}
} finally { Pop-Location;foreach($name in $vars){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')} }
