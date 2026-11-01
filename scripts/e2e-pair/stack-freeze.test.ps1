param([Parameter(Mandatory=$true)][string]$Fixture,[Parameter(Mandatory=$true)][string]$ExternalRepo)
$ErrorActionPreference='Stop'
$pair=Get-Content (Join-Path $Fixture 'pair.json') -Raw|ConvertFrom-Json
$global:stackFreezeCalls=[Collections.Generic.List[object]]::new()
function global:docker {$global:stackFreezeCalls.Add(@($args));$global:LASTEXITCODE=0}
foreach($id in @('a','b')) {
  Set-Content (Join-Path $Fixture ($id+'/world-created.json')) '{}'
  # External working files are deliberately untrusted and can change between
  # creation and teardown. Candidate snapshots remain the only Compose inputs.
  Set-Content (Join-Path $ExternalRepo 'compose.yml') 'MUTATED_EXTERNAL_BASE'
  Set-Content (Join-Path $ExternalRepo 'compose.e2e.yml') 'MUTATED_EXTERNAL_E2E'
  & (Join-Path $Fixture ($id+'/stack.ps1')) -Action up -Candidate $pair.candidate
  Set-Content (Join-Path $ExternalRepo 'compose.yml') 'MUTATED_AGAIN_AFTER_PREPARATION'
  Set-Content (Join-Path $ExternalRepo 'compose.e2e.yml') 'MUTATED_AGAIN_AFTER_PREPARATION'
  & (Join-Path $Fixture ($id+'/stack.ps1')) -Action down -Candidate $pair.candidate
}
if($global:stackFreezeCalls.Count -ne 4){throw 'Stack lifecycle did not execute both frozen up/down commands'}
foreach($call in $global:stackFreezeCalls) {
  $paths=@();for($i=0;$i -lt $call.Count;$i++){if($call[$i] -eq '-f'){$paths+=$call[$i+1]}}
  if($paths.Count -ne 3 -or @($paths|Where-Object {$_ -like ($ExternalRepo+'*')}).Count){throw 'Mutable external Compose file consumed'}
  foreach($file in $paths){if(-not $file.StartsWith($Fixture)){throw 'Compose input escaped frozen pair'}}
  if(-not ($call -contains '--project-directory')){throw 'Relocated Compose path base is implicit'}
}
$prior=$global:stackFreezeCalls.Count
Add-Content (Join-Path $Fixture 'a/frozen-compose/compose.yml') '# injected frozen-file corruption'
$refused=$false;try{& (Join-Path $Fixture 'a/stack.ps1') -Action up -Candidate $pair.candidate}catch{$refused=$true}
if(-not $refused -or $global:stackFreezeCalls.Count -ne $prior){throw 'Corrupt frozen Compose input reached Docker mutation'}
Remove-Item function:global:docker;Remove-Variable stackFreezeCalls -Scope Global
Write-Output 'PASS actual frozen stack up/down with both external inputs mutated; frozen corruption refused before Docker'
