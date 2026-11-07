param(
    [ValidateSet('Start', 'Status')]
    [string]$Action = 'Start',
    [string]$Image = 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
    [string]$FactorioSmokeVersion = '2.1.24'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path (Join-Path $Here '..\..')).Path
$SmokeScript = (Resolve-Path (Join-Path $Here 'package-smoke.ps1')).Path
$StdoutLog = Join-Path $Repo '.package-smoke-last.log'
$StderrLog = Join-Path $Repo '.package-smoke-last.err.log'
$ResultPath = Join-Path $Repo '.package-smoke-last.result.json'
$PidPath = Join-Path $Repo '.package-smoke-last.pid'

function Escape-PowerShellSingleQuoted {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value.Replace("'", "''")
}

function Show-SmokeStatus {
    $pidValue = $null
    if (Test-Path -LiteralPath $PidPath) {
        $rawPid = (Get-Content -Raw -LiteralPath $PidPath).Trim()
        $parsedPid = 0
        if ([int]::TryParse($rawPid, [ref]$parsedPid)) {
            $pidValue = $parsedPid
        }
    }

    $running = $false
    if ($null -ne $pidValue) {
        $running = $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
    }

    $result = $null
    if (Test-Path -LiteralPath $ResultPath) {
        try {
            $result = Get-Content -Raw -LiteralPath $ResultPath | ConvertFrom-Json
        }
        catch {
            Write-Warning "Result file exists but is not valid JSON: $($_.Exception.Message)"
        }
    }

    if ($running) {
        Write-Host "[pterodactyl-smoke-bg] RUNNING pid=$pidValue"
    }
    elseif ($null -ne $result) {
        Write-Host "[pterodactyl-smoke-bg] $($result.status) candidate=$($result.candidate) exitCode=$($result.exitCode)"
        if ($result.finishedAt) {
            Write-Host "[pterodactyl-smoke-bg] finishedAt=$($result.finishedAt)"
        }
        if ($result.error) {
            Write-Host "[pterodactyl-smoke-bg] error=$($result.error)"
        }
    }
    elseif ($null -ne $pidValue) {
        Write-Host "[pterodactyl-smoke-bg] INCONCLUSIVE pid=$pidValue is no longer running and no result file was written."
    }
    else {
        Write-Host '[pterodactyl-smoke-bg] No detached smoke run has been recorded.'
    }

    Write-Host "`n=== STDOUT TAIL ==="
    if (Test-Path -LiteralPath $StdoutLog) {
        Get-Content -LiteralPath $StdoutLog -Tail 120
    }
    else {
        Write-Host 'stdout log missing'
    }

    Write-Host "`n=== STDERR TAIL ==="
    if (Test-Path -LiteralPath $StderrLog) {
        Get-Content -LiteralPath $StderrLog -Tail 80
    }
    else {
        Write-Host 'stderr log missing'
    }

    if ($running) { return 0 }
    if ($null -eq $result) { return 2 }
    if ($result.status -eq 'PASS' -and [int]$result.exitCode -eq 0) { return 0 }
    return 1
}

if ($Action -eq 'Status') {
    $statusCode = Show-SmokeStatus
    exit $statusCode
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop / docker.exe is required.'
}

$dirty = (& git -C $Repo status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect the smoke worktree with git status.'
}
if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw 'Smoke worktree has local changes. Use a clean detached worktree for release-candidate validation.'
}

$candidate = ((& git -C $Repo rev-parse HEAD) -join '').Trim()
if ($LASTEXITCODE -ne 0 -or $candidate -notmatch '^[a-f0-9]{40}$') {
    throw 'Unable to resolve the exact smoke candidate commit.'
}

if (Test-Path -LiteralPath $PidPath) {
    $existingPidText = (Get-Content -Raw -LiteralPath $PidPath).Trim()
    $existingPid = 0
    if ([int]::TryParse($existingPidText, [ref]$existingPid)) {
        if ($null -ne (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
            throw "A detached package smoke is already running with PID $existingPid. Use -Action Status instead of starting another copy."
        }
    }
}

Remove-Item -Force -ErrorAction SilentlyContinue $StdoutLog, $StderrLog, $ResultPath, $PidPath

$escapedSmoke = Escape-PowerShellSingleQuoted $SmokeScript
$escapedImage = Escape-PowerShellSingleQuoted $Image
$escapedVersion = Escape-PowerShellSingleQuoted $FactorioSmokeVersion
$escapedResult = Escape-PowerShellSingleQuoted $ResultPath
$escapedCandidate = Escape-PowerShellSingleQuoted $candidate

# Start-Process's normal -ArgumentList handling is lossy for nested command strings.
# Encode the entire child program as UTF-16LE so the child receives exactly one
# opaque command payload and package-smoke.ps1 can preserve its Docker bash -lc
# validation argument byte-for-byte.
$childProgram = @"
`$ErrorActionPreference = 'Stop'
`$resultPath = '$escapedResult'
`$candidate = '$escapedCandidate'
try {
    & '$escapedSmoke' -Image '$escapedImage' -FactorioSmokeVersion '$escapedVersion'
    `$record = [pscustomobject]@{
        status = 'PASS'
        exitCode = 0
        candidate = `$candidate
        finishedAt = (Get-Date).ToString('o')
        error = `$null
    }
    `$record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath `$resultPath -Encoding utf8
    exit 0
}
catch {
    `$record = [pscustomobject]@{
        status = 'FAIL'
        exitCode = 1
        candidate = `$candidate
        finishedAt = (Get-Date).ToString('o')
        error = `$_.Exception.Message
    }
    `$record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath `$resultPath -Encoding utf8
    Write-Error `$_.Exception.ToString()
    exit 1
}
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childProgram))
$powerShellExe = (Get-Process -Id $PID).Path
if ([string]::IsNullOrWhiteSpace($powerShellExe)) {
    throw 'Unable to resolve the current PowerShell executable.'
}

$process = Start-Process `
    -FilePath $powerShellExe `
    -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -WorkingDirectory $Repo `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -WindowStyle Hidden `
    -PassThru

Set-Content -LiteralPath $PidPath -Value $process.Id -Encoding ascii
Write-Host "[pterodactyl-smoke-bg] Started detached smoke candidate=$candidate pid=$($process.Id)"
Write-Host "[pterodactyl-smoke-bg] stdout=$StdoutLog"
Write-Host "[pterodactyl-smoke-bg] stderr=$StderrLog"
Write-Host "[pterodactyl-smoke-bg] result=$ResultPath"
Write-Host '[pterodactyl-smoke-bg] Query with: .\deploy\pterodactyl\package-smoke-background.ps1 -Action Status'
