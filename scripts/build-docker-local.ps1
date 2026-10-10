param(
    [switch]$Restart,
    [switch]$NoEnvUpdate,
    [string]$EnvFilePath,
    [string]$ProjectName,
    [string[]]$ComposeFiles = @('compose.yml')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$marker = Join-Path $repo '.docker-local-source-sha'
$envFile = if ($EnvFilePath) { [System.IO.Path]::GetFullPath($EnvFilePath) } else { Join-Path $repo '.env' }
if ($EnvFilePath -and -not $NoEnvUpdate) { throw 'An external env file requires -NoEnvUpdate; it is consumed opaquely and never edited.' }
if ($ProjectName -and $ProjectName -notmatch '^[a-z0-9][a-z0-9_-]+$') { throw 'Invalid isolated Compose project name.' }
$composeArgs = @('compose', '--env-file', $envFile)
if ($ProjectName) { $composeArgs += @('--project-name', $ProjectName) }
foreach ($composeFile in $ComposeFiles) { $composeArgs += @('--file', $composeFile) }
$createdMarker = $false

Push-Location $repo
$oldSourceRef = $env:SGLUNA_SOURCE_REF
$oldLocalSource = $env:SGLUNA_LOCAL_SOURCE
try {
    $sha = (& git -c "safe.directory=$repo" rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify HEAD commit.' }
    if (@(& git -c "safe.directory=$repo" status --porcelain).Count -ne 0) { throw 'Commit or discard working-tree changes before a pinned local build.' }
    if (Test-Path -LiteralPath $marker) { throw 'Stale local-source marker exists; inspect it before rebuilding.' }
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'Local .env file is missing.' }

    [System.IO.File]::WriteAllText($marker, "$sha`n")
    $createdMarker = $true
    $env:SGLUNA_SOURCE_REF = $sha
    $env:SGLUNA_LOCAL_SOURCE = '1'

    & docker @composeArgs build sgluna-factorio
    if ($LASTEXITCODE -ne 0) { throw 'Local Docker build failed.' }

    # Isolated runs keep source/model overrides in the process environment.
    if (-not $NoEnvUpdate) {
        $content = [System.IO.File]::ReadAllText($envFile)
        $pattern = '(?m)^SGLUNA_SOURCE_REF=[^\r\n]*$'
        if (-not [regex]::IsMatch($content, $pattern)) { throw '.env has no SGLUNA_SOURCE_REF entry.' }
        [System.IO.File]::WriteAllText($envFile, [regex]::Replace($content, $pattern, "SGLUNA_SOURCE_REF=$sha"))
    }

    if ($Restart) {
        & docker @composeArgs up -d --no-build --force-recreate sgluna-factorio
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
