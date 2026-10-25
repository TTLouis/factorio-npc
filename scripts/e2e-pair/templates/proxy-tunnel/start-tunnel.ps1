$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'tunnel-lifecycle.ps1')
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'tunnel-state.json')){throw 'Tunnel ownership receipt already exists; inspect before restarting'}
$taskCfg=Get-Content -Raw 'D:/SideProjects/SSH set up helper/config/servers.json' | ConvertFrom-Json
$taskServer=$taskCfg.servers | Where-Object {$_.alias -eq 'docker-vm'}
$taskTs=(& tailscale status --json | ConvertFrom-Json)
$taskPeer=$taskTs.Peer.PSObject.Properties.Value | Where-Object {$_.HostName -eq 'ttdocker'}
$taskConnectHost=[string]$taskServer.host
$taskTransport='configured_ssh'
if($taskPeer.Online){$taskConnectHost=$taskPeer.TailscaleIPs[0];$taskTransport='tailscale'}
$taskKey=([string]$taskServer.identityFile).Replace('~/',($env:USERPROFILE+'/')).Replace('~\',($env:USERPROFILE+'\'))
if($taskKey -match '\s|"'){throw 'Identity path needs explicit Windows quoting review'}
$taskLocalPort=[int](Get-Content (Join-Path $PSScriptRoot 'target-port.txt'))
$taskPorts=(& (Join-Path $PSScriptRoot 'vm-command.ps1') -Command 'docker inspect --format "{{json .NetworkSettings.Ports}}" ai-gateway-cpa' | ConvertFrom-Json)
$taskBindings=@($taskPorts.PSObject.Properties.Value | ForEach-Object {$_} | Where-Object {$_.HostIp -eq '127.0.0.1'})
if($taskBindings.Count -ne 1){throw 'Expected one loopback-only CLI proxy publication'}
$taskRemotePort=[int]$taskBindings[0].HostPort
if(@(Get-NetTCPConnection -State Listen -LocalPort $taskLocalPort -ErrorAction SilentlyContinue).Count -gt 0){throw 'Configured local port already occupied; no process was stopped'}
$taskTarget=([string]$taskServer.user)+'@'+$taskConnectHost
$taskArgs=@('-N','-T','-i',$taskKey,'-p',[string]$taskServer.port,'-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o',('HostKeyAlias='+$taskServer.host),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-L',("127.0.0.1:${taskLocalPort}:127.0.0.1:${taskRemotePort}"),$taskTarget)
$taskState=Start-OwnedTunnel -StatePath (Join-Path $PSScriptRoot 'tunnel-state.json') -LocalPort $taskLocalPort -Start {
  Start-Process -FilePath (Get-Command ssh).Source -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $PSScriptRoot 'tunnel-stderr.log') -RedirectStandardOutput (Join-Path $PSScriptRoot 'tunnel-stdout.log')
} -Metadata @{HostKeyVerification='strict';KeepaliveSeconds=30;Transport=$taskTransport}
$taskState | ConvertTo-Json -Compress
