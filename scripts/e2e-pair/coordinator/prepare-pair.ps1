. (Join-Path $PSScriptRoot 'pair-common.ps1')
Assert-PairFrozen
$pair=Read-Pair
$ready=$false
try {
  if((Read-QuotaDecision $pair) -ne 'continue'){throw 'Fresh shared-account quota proof required'}
  foreach($lane in $pair.lanes) {
    & (Join-Path $PSScriptRoot ($lane.id+'/prepare-stack.ps1')) *> (Join-Path $PSScriptRoot ($lane.id+'/prepare-stack.log'))
    if(-not $?){throw 'Independent lane preparation failed'}
  }
  $ready=$true
} finally {
  if(-not $ready) {
    $errors=@()
    foreach($lane in $pair.lanes) {
      try { & (Join-Path $PSScriptRoot ($lane.id+'/stack.ps1')) -Action down -Candidate $pair.candidate *> (Join-Path $PSScriptRoot ($lane.id+'/prepare-pair-down.log')) }
      catch { $errors+=($lane.id+': compose teardown failed') }
      try { & (Join-Path $PSScriptRoot ($lane.id+'/finish-cleanup.ps1')) *> (Join-Path $PSScriptRoot ($lane.id+'/prepare-pair-cleanup.log')) }
      catch { $errors+=($lane.id+': cleanup unverified') }
    }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'prepare-pair-failure.json'),(@{pairId=$pair.pairId;errors=$errors;imageRetained=$true}|ConvertTo-Json))
  }
}
