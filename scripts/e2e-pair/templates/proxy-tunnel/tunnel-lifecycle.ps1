function Stop-OwnedTunnel {
  param([Parameter(Mandatory=$true)]$State,
    [scriptblock]$GetProcess={param($ProcessId) Get-Process -Id $ProcessId -ErrorAction SilentlyContinue},
    [scriptblock]$StopProcess={param($Process) Stop-Process -InputObject $Process -ErrorAction Stop;$Process.WaitForExit(5000)|Out-Null},
    [scriptblock]$Listeners={param($Port) Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue})
  $current=& $GetProcess ([int]$State.PID)
  if($current){
    $recorded=[DateTimeOffset]::Parse([string]$State.StartedUTC).UtcDateTime
    if($current.Id -ne [int]$State.PID -or $current.ProcessName -ne 'ssh' -or $current.StartTime.ToUniversalTime().Ticks -ne $recorded.Ticks){throw 'Owned tunnel identity changed; refusing to stop'}
    & $StopProcess $current
  }
  if((& $GetProcess ([int]$State.PID)) -or @(& $Listeners ([int]$State.LocalPort) | Where-Object OwningProcess -EQ ([int]$State.PID)).Count){throw 'Owned tunnel cleanup incomplete'}
  return [pscustomobject]@{PID=[int]$State.PID;StartedUTC=$State.StartedUTC;process_absent=$true;owned_listener_absent=$true}
}

function Start-OwnedTunnel {
  param([Parameter(Mandatory=$true)][string]$StatePath,[Parameter(Mandatory=$true)][int]$LocalPort,
    [Parameter(Mandatory=$true)][scriptblock]$Start,
    [scriptblock]$Wait={Start-Sleep -Seconds 2},
    [scriptblock]$GetProcess={param($ProcessId) Get-Process -Id $ProcessId -ErrorAction SilentlyContinue},
    [scriptblock]$StopProcess={param($Process) Stop-Process -InputObject $Process -ErrorAction Stop;$Process.WaitForExit(5000)|Out-Null},
    [scriptblock]$Listeners={param($Port) Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue},
    [hashtable]$Metadata=@{})
  if(Test-Path -LiteralPath $StatePath){throw 'Tunnel ownership receipt already exists; inspect before restarting'}
  if(@(& $Listeners $LocalPort).Count){throw 'Configured local port already occupied; no process was stopped'}
  $state=$null
  try {
    $created=& $Start
    # Record the actual process start time before any waits or readiness queries.
    $state=[ordered]@{PID=$created.Id;StartedUTC=$created.StartTime.ToUniversalTime().ToString('o');LocalPort=$LocalPort;ListenerPresent=$false;LoopbackOnly=$false;Status='starting'}
    foreach($key in $Metadata.Keys){if($state.Contains($key)){throw 'Tunnel metadata cannot replace ownership fields'};$state[$key]=$Metadata[$key]}
    [IO.File]::WriteAllText($StatePath,(ConvertTo-Json -InputObject $state -Depth 5))
    & $Wait
    $current=& $GetProcess ([int]$state.PID)
    if(-not $current -or $current.ProcessName -ne 'ssh' -or $current.StartTime.ToUniversalTime().Ticks -ne [DateTimeOffset]::Parse([string]$state.StartedUTC).UtcDateTime.Ticks){throw 'Tunnel did not retain its process identity'}
    $active=@(& $Listeners $LocalPort)
    if(-not $active.Count -or @($active | Where-Object {$_.OwningProcess -ne [int]$state.PID -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw 'Owned loopback-only tunnel listener not confirmed'}
    $state.ListenerPresent=$true;$state.LoopbackOnly=$true;$state.Status='ready'
    [IO.File]::WriteAllText($StatePath,(ConvertTo-Json -InputObject $state -Depth 5))
    return [pscustomobject]$state
  } catch {
    $cleanup=[ordered]@{status='no_process_created';reason='startup_failed';ownership_receipt_written=(Test-Path -LiteralPath $StatePath)}
    if($state){
      try {$cleanup.proof=Stop-OwnedTunnel -State $state -GetProcess $GetProcess -StopProcess $StopProcess -Listeners $Listeners;$cleanup.status='owned_process_removed'}
      catch {$cleanup.status='cleanup_refused_or_incomplete'}
    }
    [IO.File]::WriteAllText(($StatePath+'.startup-failure.json'),(ConvertTo-Json -InputObject $cleanup -Depth 6))
    throw "Tunnel startup failed; cleanup status: $($cleanup.status); local ownership proof retained"
  }
}
