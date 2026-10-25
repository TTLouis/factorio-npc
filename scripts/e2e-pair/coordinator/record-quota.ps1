param([Parameter(Mandatory=$true)][ValidateRange(0,100)][double]$RemainingPercent,[Parameter(Mandatory=$true)][long]$ObservedAtUnixMs,[Parameter(Mandatory=$true)][int]$MatchingWeeklyWindows)
. (Join-Path $PSScriptRoot 'pair-common.ps1')
$pair=Read-Pair
# The parent supplies a fresh actual shared-account weekly-window observation.
# This command does not query providers or infer quota from lane call counts.
if($MatchingWeeklyWindows -ne 1){throw 'Exactly one 10080 minute usage window required; do not write an ambiguous receipt'}
$record=@{pairId=$pair.pairId;remainingPercent=$RemainingPercent;observedAt=$ObservedAtUnixMs;scope='shared_account';source='get_usage_limits';observedBy='parent:/root';matchingWeeklyWindows=$MatchingWeeklyWindows;windowDurationMins=10080;recordedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
$line=($record|ConvertTo-Json -Compress)
Add-Content (Join-Path $PSScriptRoot 'quota-history.jsonl') $line
$file=Join-Path $PSScriptRoot 'quota-latest.json'
[IO.File]::WriteAllText(($file+'.new'),$line)
Move-Item -LiteralPath ($file+'.new') -Destination $file -Force
Read-QuotaDecision $pair
