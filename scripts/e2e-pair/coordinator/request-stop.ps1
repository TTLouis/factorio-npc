param([Parameter(Mandatory=$true)][ValidateSet('a','b')][string]$Lane,[ValidateSet('owner_canceled','canceled_after_peer_verified_success')][string]$Reason='owner_canceled')
. (Join-Path $PSScriptRoot 'pair-common.ps1')
Assert-PairFrozen
$pair=Read-Pair
$target=$pair.lanes|Where-Object id -EQ $Lane
if($Reason -eq 'canceled_after_peer_verified_success') {
  $peer=$pair.lanes|Where-Object id -NE $Lane
  $proof=Join-Path $PSScriptRoot ($peer.id+'/peer-acceptance.json')
  if(-not(Test-Path $proof)){throw 'Run verify-peer-success.mjs for the other lane before requesting this stop'}
  $acceptance=Get-Content $proof -Raw|ConvertFrom-Json
  if($acceptance.runId -ne $peer.runId -or $acceptance.candidate -ne $pair.candidate -or $acceptance.verified -ne $true){throw 'Peer native acceptance mismatch'}
  # Re-evaluate current source evidence, not an old receipt alone.
  & node (Join-Path $PSScriptRoot 'verify-peer-success.mjs') $peer.id
  if($LASTEXITCODE -ne 0){throw 'Peer acceptance no longer verifies'}
  Write-LaneStop $target $Reason $peer.runId (Get-FileHash $proof -Algorithm SHA256).Hash.ToLowerInvariant()
} else { Write-LaneStop $target $Reason }
$null=Invoke-LaneSupervisorStop $target
