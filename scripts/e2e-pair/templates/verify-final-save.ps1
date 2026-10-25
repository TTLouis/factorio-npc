param([switch]$Emergency)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-resources.ps1')
$resultPath=Join-Path $PSScriptRoot $(if($Emergency){'data/logs/e2e-emergency-result.json'}else{'data/logs/e2e-result.json'})
$savePath=Join-Path $PSScriptRoot 'data/saves/@@SAVE_NAME@@.zip'
$gameLogPath=Join-Path $PSScriptRoot 'data/factorio-current.log'
if(-not(Test-Path -LiteralPath $resultPath)){throw 'No result/paired-stop evidence; keep safe stack up'}
$result=Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json -DateKind String
if(-not $result.stop_confirmation -or -not $result.stop_confirmation.intake_retry_cleared -or -not $result.stop_confirmation.native_crafting_queue_empty -or $result.stop_confirmation.native_queue_length -ne 0 -or $result.stop_confirmation.native_task_state -ne 'idle'){throw 'Stop evidence incomplete; keep safe stack up'}
$stop=$result.stop_confirmation
if($stop.boundary -ne 'fresh_supervisor_cancel_and_same_goal_operator_pause'){throw 'Strict paired stop boundary absent; keep safe stack up'}
if($stop.goal_id -ne $result.goal_id -or -not $stop.actor_id){throw 'Stop goal/actor identity mismatch; keep safe stack up'}
if($stop.receipt_scope.run_id -ne '@@RUN_ID@@' -or $stop.receipt_scope.trace_source -ne 'isolated_supervisor_behavior_trace' -or $stop.receipt_scope.trace_path -ne '/data/logs/sgluna-behavior.jsonl'){throw 'paired lane receipt scope mismatch; keep safe stack up'}
if($stop.stop_receipt.event -ne 'request.cancelled' -or $stop.stop_receipt.data.reason -ne 'user_stop_immediate'){throw 'Fresh cancellation receipt absent; keep safe stack up'}
if($stop.operator_pause_receipt.event -ne 'goal.paused' -or $stop.operator_pause_receipt.data.goal_id -ne $result.goal_id -or $stop.operator_pause_receipt.data.cause -ne 'user_stop' -or $stop.operator_pause_receipt.data.pause_class -ne 'operator'){throw 'Same-goal operator pause receipt absent; keep safe stack up'}
$submitted=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$result.stop_confirmation.submitted_at)
$confirmed=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$result.stop_confirmation.confirmed_at)
$cancel=[DateTimeOffset]::Parse([string]$stop.stop_receipt.ts)
$pause=[DateTimeOffset]::Parse([string]$stop.operator_pause_receipt.ts)
if($cancel -lt $submitted -or $pause -lt $cancel -or $confirmed -lt $pause){throw 'Stop receipt ordering invalid; keep safe stack up'}
if(-not(Test-Path -LiteralPath $savePath)){throw 'Checkpoint absent; result is provisional; keep safe stack up'}
$save=Get-Item -LiteralPath $savePath
if($save.Length -le 0 -or $save.LastWriteTimeUtc -lt $confirmed.UtcDateTime){throw 'Checkpoint empty or stale; keep safe stack up'}
$lines=@(Get-Content -LiteralPath $gameLogPath)
$start=-1
for($i=0;$i -lt $lines.Count;$i++){if($lines[$i] -match 'Saving game as /data/saves/@@SAVE_NAME@@(?:\.zip)?\s*$'){$start=$i}}
if($start -lt 0){throw 'Factorio checkpoint save start absent; keep safe stack up'}
$finish=-1
for($i=$start+1;$i -lt $lines.Count;$i++){if($lines[$i] -match 'Saving game as '){break};if($lines[$i] -match 'Saving finished\s*$'){$finish=$i;break}}
if($finish -lt 0){throw 'Factorio checkpoint save completion unconfirmed; keep safe stack up'}
$archiveCheck=@'
import json,runpy
checker=runpy.run_path('/evidence/save-archive-check.py')
print(json.dumps(checker['inspect_save']('/evidence/data/saves/@@SAVE_NAME@@.zip')))
'@
$archiveOutputFile='archive-check-'+$Emergency
Invoke-OwnedProof -Name ('@@RESOURCE_PREFIX@@-archive-'+$Emergency.ToString().ToLowerInvariant()) -Output $archiveOutputFile -Arguments @('--mount',"type=bind,source=$PSScriptRoot,target=/evidence,readonly",'--entrypoint','python3','sha256:c23de29f686824ca7598116b07ed0b80697af354edef26c0e0eea20287fb3697','-c',$archiveCheck)
$archiveOutput=Get-Content (Join-Path $PSScriptRoot ($archiveOutputFile+'.log')) -Raw

$archiveProof=$archiveOutput | ConvertFrom-Json -DateKind String
if($archiveProof.zip_integrity -ne 'pass' -or $archiveProof.archive_entries -le 0){throw 'Archive verification output absent or invalid; keep safe stack up'}
$after=Get-Item -LiteralPath $savePath
if($after.Length -ne $save.Length -or $after.LastWriteTimeUtc -ne $save.LastWriteTimeUtc){throw 'Save changed during verification; keep safe stack up'}
$proof=[ordered]@{verified_at=[DateTime]::UtcNow.ToString('o');result=$result.result;goal_id=$result.goal_id;stop_submitted_at=$submitted.ToString('o');stop_confirmed_at=$confirmed.ToString('o');save_bytes=$save.Length;save_modified_at=$save.LastWriteTimeUtc.ToString('o');fresh_after_stop_confirmation=$true;factorio_save_started=$lines[$start];factorio_save_completed=$lines[$finish];zip_integrity=$archiveProof.zip_integrity;archive_entries=$archiveProof.archive_entries;native_level_layout=$archiveProof.native_level_layout;native_level_chunks=$archiveProof.native_level_chunks;save_sha256=(Get-FileHash -LiteralPath $savePath -Algorithm SHA256).Hash.ToLowerInvariant();result_sha256=(Get-FileHash -LiteralPath $resultPath -Algorithm SHA256).Hash.ToLowerInvariant()}
$json=ConvertTo-Json -InputObject $proof -Depth 5
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data/logs/final-save-proof.json'),$json)
$json
