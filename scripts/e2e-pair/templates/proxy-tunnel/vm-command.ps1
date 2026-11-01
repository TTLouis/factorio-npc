param([Parameter(Mandatory=$true)][string]$Command)
$ErrorActionPreference='Stop'
$taskCfg=Get-Content -Raw 'D:/SideProjects/SSH set up helper/config/servers.json' | ConvertFrom-Json
$taskServer=$taskCfg.servers | Where-Object {$_.alias -eq 'docker-vm'}
$taskTs=(& tailscale status --json | ConvertFrom-Json)
$taskPeer=$taskTs.Peer.PSObject.Properties.Value | Where-Object {$_.HostName -eq 'ttdocker'}
$taskConnectHost=[string]$taskServer.host
$taskTransport='configured_ssh'
if($taskPeer.Online){$taskConnectHost=$taskPeer.TailscaleIPs[0];$taskTransport='tailscale'}
$taskKey=([string]$taskServer.identityFile).Replace('~/',($env:USERPROFILE+'/')).Replace('~\',($env:USERPROFILE+'\'))
$taskTarget=([string]$taskServer.user)+'@'+$taskConnectHost
$taskOutput=& ssh -i $taskKey -p ([string]$taskServer.port) -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o ('HostKeyAlias='+$taskServer.host) $taskTarget $Command 2>&1
if($LASTEXITCODE -ne 0){throw 'Docker VM SSH command failed; endpoint-bearing stderr suppressed'}
$taskOutput
