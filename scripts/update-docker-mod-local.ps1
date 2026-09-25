param(
    [switch]$Restart
)

# Replace only the Autorio mod in the local server image, built from this
# committed checkout inside Docker (deploy/docker/Dockerfile.mod-overlay) the
# same way the installer builds it. Anything outside the mod needs the full
# local build (scripts/build-docker-local.ps1).

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
# tests/ never reaches the server image, so test-only changes don't need a full build.
$allowed = '^(packages/autorio/|deploy/docker/|docs/|tests/|\.dockerignore$|\.gitignore$|compose\.yml$|scripts/(build-docker-local|update-docker-mod-local)\.ps1$)'

Push-Location $repo
try {
    $sha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify HEAD commit.' }
    if (@(& git status --porcelain).Count -ne 0) { throw 'Commit or discard working-tree changes before a mod-only update.' }

    $baseSha = (& docker run --rm --entrypoint cat factorio-npc:local /opt/airi/SOURCE_SHA).Trim()
    if ($LASTEXITCODE -ne 0 -or $baseSha -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the base image source commit.' }
    & git merge-base --is-ancestor $baseSha HEAD
    if ($LASTEXITCODE -ne 0) { throw 'The image source is not an ancestor of HEAD; use the full local build.' }
    $changed = @(& git diff --name-only "$baseSha..HEAD")
    if ($LASTEXITCODE -ne 0) { throw 'Cannot compare the image and checkout.' }
    $unsupported = @($changed | Where-Object { $_ -notmatch $allowed })
    if ($unsupported.Count -gt 0) { throw "Non-mod runtime files changed: $($unsupported -join ', '). Use the full local build." }

    & docker build --build-arg "MOD_SOURCE_SHA=$sha" -t factorio-npc:local -f deploy/docker/Dockerfile.mod-overlay .
    if ($LASTEXITCODE -ne 0) { throw 'Mod-only Docker image build failed.' }
    if ($Restart) {
        & docker compose up -d --no-build --force-recreate sgluna-factorio
        if ($LASTEXITCODE -ne 0) { throw 'Mod image built, but container restart failed.' }
    }
    Write-Output "Built Autorio from $sha on base $baseSha$(if ($Restart) { ' and restarted the container' })."
}
finally {
    Pop-Location
}
