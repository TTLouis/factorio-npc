$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-resources.ps1')
$failures=@()
try { if(Test-Path (Join-Path $PSScriptRoot 'analysis/recorder-process.json')){& (Join-Path $PSScriptRoot 'analysis/stop-recorder.ps1');if(-not $?){throw 'Recorder cleanup failed'}} } catch { $failures+='recorder identity/cleanup unverified' }
try {
  if(Test-Path (Join-Path $PSScriptRoot 'proxy-tunnel/tunnel-state.json')) {
    . (Join-Path $PSScriptRoot 'proxy-tunnel/tunnel-lifecycle.ps1')
    $tunnel=Get-Content (Join-Path $PSScriptRoot 'proxy-tunnel/tunnel-state.json') -Raw|ConvertFrom-Json -DateKind String
    if($tunnel.LocalPort -ne @@TUNNEL_PORT@@){throw 'Tunnel receipt belongs to another lane'}
    $null=Stop-OwnedTunnel -State $tunnel
  }
} catch { $failures+='tunnel identity/cleanup unverified' }
$containers=@(Docker-Inventory @('ps','-aq','--no-trunc','--filter','label=owner.run=@@RUN_ID@@'))
$compose=@(Docker-Inventory @('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=@@PROJECT@@'))
$networks=@(Docker-Inventory @('network','ls','-q','--filter','label=com.docker.compose.project=@@PROJECT@@'))
$volumes=@(Docker-Inventory @('volume','ls','-q','--filter','label=com.docker.compose.project=@@PROJECT@@'))
if($containers.Count -or $compose.Count -or $networks.Count -or $volumes.Count){$failures+='owned Docker resources remain'}
$proof=@{runId='@@RUN_ID@@';cleanupVerified=($failures.Count -eq 0);containers=$containers;compose=$compose;networks=$networks;volumes=$volumes;failures=$failures;imageRetained='Pair coordinator owns image lifetime; peer lane may still be running'}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'cleanup-proof.json'),($proof|ConvertTo-Json -Depth 6))
if($failures.Count){throw ($failures -join '; ')}
