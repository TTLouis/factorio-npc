$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-resources.ps1')
Assert-FrozenHelpers
$success=$false
$container='@@PROJECT@@-sgluna-factorio-1'
try {
  & (Join-Path $PSScriptRoot 'create-world.ps1')
  & (Join-Path $PSScriptRoot 'proxy-tunnel/start-tunnel.ps1') *> (Join-Path $PSScriptRoot 'proxy-tunnel/start.log')
  if(-not $?){throw 'Configured tunnel setup failed'}
  & (Join-Path $PSScriptRoot 'analysis/start-recorder.ps1') *> (Join-Path $PSScriptRoot 'analysis/recorder-start.log')
  if(-not $?){throw 'Recorder setup failed'}
  & (Join-Path $PSScriptRoot 'stack.ps1') -Action up -Candidate '@@CANDIDATE@@' *> (Join-Path $PSScriptRoot 'stack-up.log')
  $cid=(& docker container inspect --format '{{.Id}}' $container).Trim()
  if($LASTEXITCODE -ne 0 -or $cid -notmatch '^[a-f0-9]{64}$'){throw 'Owned container identity missing'}
  Set-Content (Join-Path $PSScriptRoot 'live-container.cid') $cid
  $null=Assert-OwnedContainer $cid
  $deadline=[DateTime]::UtcNow.AddSeconds(180)
  for(;;) {
    $nativeLog=& docker logs $cid 2>&1
    if($LASTEXITCODE -ne 0){throw 'Cannot read owned startup log'}
    $text=$nativeLog -join "`n"
    if($text -match 'SGLuna Factorio ready;'){break}
    if($text -match 'Sprint startup clock recovery exhausted' -or [DateTime]::UtcNow -ge $deadline){throw 'Startup ready fence failed; no inference attempted'}
    Start-Sleep -Seconds 2
  }
  $release=(& docker exec $cid sh -c 'dirname "$(readlink -f /opt/sgluna/start-sgluna.sh)"').Trim()
  if($LASTEXITCODE -ne 0 -or $release -notmatch '^/opt/sgluna/\.sgluna/releases/[A-Za-z0-9._-]+$'){throw 'Cannot resolve deployed release'}
  $node="$release/node/bin/node"
  Set-Content (Join-Path $PSScriptRoot 'deployed-node-path.txt') $node
  & docker exec $cid $node -e "const r=await fetch('http://host.docker.internal:@@RECORDER_PORT@@/__e2e_recorder_health');const b=await r.json();if(!r.ok||!b.ok)process.exit(1);console.log(JSON.stringify({route:'container-to-lane-recorder',...b}));" *> (Join-Path $PSScriptRoot 'recorder-container-health.json')
  if($LASTEXITCODE -ne 0){throw 'Lane recorder route failed'}
  foreach($script in @('verify-deployment.mjs','verify-native-mod.mjs','preflight.mjs','supervisor-preflight.mjs','prelaunch-cold-check.mjs')) {
    & docker exec $cid $node "/e2e/$script" *> (Join-Path $PSScriptRoot ($script+'.log'))
    $code=$LASTEXITCODE
    Set-Content (Join-Path $PSScriptRoot ($script+'.exit')) $code
    if($code -ne 0){throw "Read-only lane preflight failed: $script"}
  }
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'preflight-ready.json'),(@{runId='@@RUN_ID@@';source='@@CANDIDATE@@';seed=@@SEED@@;container=$cid;ready=$true;inferenceCalls=0}|ConvertTo-Json))
  $success=$true
} finally {
  if(-not $success) {
    try { & (Join-Path $PSScriptRoot 'stack.ps1') -Action down -Candidate '@@CANDIDATE@@' *> (Join-Path $PSScriptRoot 'preflight-down.log') }
    finally { & (Join-Path $PSScriptRoot 'finish-cleanup.ps1') *> (Join-Path $PSScriptRoot 'preflight-cleanup.log') }
  }
}
