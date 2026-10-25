. (Join-Path $PSScriptRoot 'pair-common.ps1')
$pair=Read-Pair
if((Test-Path (Join-Path $PSScriptRoot 'pair-launch-once.json')) -or (Test-Path (Join-Path $PSScriptRoot 'pair-prepared.json'))){throw 'Pair already prepared/launched; duplicate has no cleanup authority'}
$controller=Enter-PairController $pair 'prepare'
$ready=$false
try {
  Assert-PairFrozen
  if((Read-QuotaDecision $pair) -ne 'continue'){throw 'Fresh shared-account quota proof required'}
  foreach($lane in $pair.lanes) {
    & (Join-Path $PSScriptRoot ($lane.id+'/prepare-stack.ps1')) *> (Join-Path $PSScriptRoot ($lane.id+'/prepare-stack.log'))
    if(-not $?){throw 'Independent lane preparation failed'}
  }
  $prepared=@{pairId=$pair.pairId;candidate=$pair.candidate;imageId=$pair.imageId;lanes=@($pair.lanes|ForEach-Object {@{id=$_.id;runId=$_.runId}});preparedAt=[DateTime]::UtcNow.ToString('o')}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pair-prepared.json'),($prepared|ConvertTo-Json -Depth 6))
  $ready=$true
} finally {
  try {
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
  } finally {Exit-PairController $controller}
}
