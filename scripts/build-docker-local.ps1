param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$marker = Join-Path $repo '.docker-local-source-sha'
$envFile = Join-Path $repo '.env'
$createdMarker = $false

Push-Location $repo
$oldSourceRef = $env:SGLUNA_SOURCE_REF
$oldLocalSource = $env:SGLUNA_LOCAL_SOURCE
try {
    $sha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify HEAD commit.' }
    if (@(& git status --porcelain).Count -ne 0) { throw 'Commit or discard working-tree changes before a pinned local build.' }
    if (Test-Path -LiteralPath $marker) { throw 'Stale local-source marker exists; inspect it before rebuilding.' }
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'Local .env file is missing.' }

    [System.IO.File]::WriteAllText($marker, "$sha`n")
    $createdMarker = $true
    $env:SGLUNA_SOURCE_REF = $sha
    $env:SGLUNA_LOCAL_SOURCE = '1'

    & docker compose build sgluna-factorio
    if ($LASTEXITCODE -ne 0) { throw 'Local Docker build failed.' }

    $content = [System.IO.File]::ReadAllText($envFile)
    $pattern = '(?m)^SGLUNA_SOURCE_REF=[^\r\n]*$'
    if (-not [regex]::IsMatch($content, $pattern)) { throw '.env has no SGLUNA_SOURCE_REF entry.' }
    [System.IO.File]::WriteAllText($envFile, [regex]::Replace($content, $pattern, "SGLUNA_SOURCE_REF=$sha"))

    if ($Restart) {
        & docker compose up -d --no-build --force-recreate sgluna-factorio
        if ($LASTEXITCODE -ne 0) { throw 'Image built, but container restart failed.' }
    }
    Write-Output "Built local source $sha$(if ($Restart) { ' and restarted the container' })."
}
finally {
    if ($createdMarker -and (Test-Path -LiteralPath $marker)) { Remove-Item -LiteralPath $marker }
    [Environment]::SetEnvironmentVariable('SGLUNA_SOURCE_REF', $oldSourceRef, 'Process')
    [Environment]::SetEnvironmentVariable('SGLUNA_LOCAL_SOURCE', $oldLocalSource, 'Process')
    Pop-Location
}
