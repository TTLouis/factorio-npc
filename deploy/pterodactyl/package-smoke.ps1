param(
    [string]$Image = 'ghcr.io/ptero-eggs/yolks:debian_bookworm',
    [string]$FactorioSmokeVersion = '2.0.77',
    # Exact 40-character commit SHA to install, matching package-smoke.sh's
    # SGLUNA_SMOKE_SOURCE_REF/AIRI_SMOKE_SOURCE_REF. Defaults to either env
    # var, then to the egg's own default channel (normally main) when unset.
    [string]$SourceRef = $(if ($env:SGLUNA_SMOKE_SOURCE_REF) { $env:SGLUNA_SMOKE_SOURCE_REF } else { $env:AIRI_SMOKE_SOURCE_REF })
)

if ($SourceRef -and $SourceRef -notmatch '^[a-f0-9]{40}$') {
    throw 'SourceRef must be an exact 40-character commit SHA.'
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path (Join-Path $Here '..\..')).Path
$InstallScript = (Resolve-Path (Join-Path $Here 'install.sh')).Path
$EggPath = (Resolve-Path (Join-Path $Here 'egg-sgluna-factorio-server.json')).Path
$Suffix = ([guid]::NewGuid().ToString('N')).Substring(0, 10)
$Volume = "airi-ptero-smoke-$PID-$Suffix"
$Container = "airi-ptero-smoke-$PID-$Suffix"
$EggInstallScript = Join-Path ([System.IO.Path]::GetTempPath()) "airi-ptero-egg-install-$PID-$Suffix.sh"

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-DockerOutput {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = & docker @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop / docker.exe is required.'
}

Write-Host '[pterodactyl-smoke] Checking Docker daemon.'
Invoke-Docker -Arguments @('info')

try {
    Write-Host '[pterodactyl-smoke] Verifying generated artifacts without host Node.'
    Invoke-Docker -Arguments @(
        'run', '--rm',
        '-v', "${Repo}:/src",
        '-w', '/src',
        'node:24-bookworm',
        'node', 'deploy/pterodactyl/build-payload.mjs', '--check'
    )

    Write-Host '[pterodactyl-smoke] Parsing the committed PTDL_v2 egg and extracting its real install script.'
    $Egg = Get-Content -Raw -LiteralPath $EggPath | ConvertFrom-Json
    $EggInstallText = [string]$Egg.scripts.installation.script
    if ([string]::IsNullOrWhiteSpace($EggInstallText)) {
        throw 'Egg installation script is missing or empty.'
    }
    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($EggInstallScript, $EggInstallText, $Utf8NoBom)

    Write-Host '[pterodactyl-smoke] Creating disposable Docker volume.'
    Invoke-Docker -Arguments @('volume', 'create', $Volume)

    Write-Host '[pterodactyl-smoke] Verifying standalone generated bootstrap payload.'
    Invoke-Docker -Arguments @(
        'run', '--rm',
        '-v', "${InstallScript}:/tmp/install.sh:ro",
        '-v', "${Volume}:/mnt/server",
        '-e', 'SGLUNA_INSTALL_ROOT=/mnt/server',
        $Image,
        'bash', '/tmp/install.sh', '--verify-only'
    )

    Write-Host "[pterodactyl-smoke] Performing clean installation through the egg loader.$(if ($SourceRef) { " Pinned source: $SourceRef" })"
    $SourceRefArgs = if ($SourceRef) { @('-e', "SGLUNA_SOURCE_REF=$SourceRef") } else { @() }
    Invoke-Docker -Arguments (@(
        'run', '--rm',
        '-v', "${EggInstallScript}:/tmp/egg-install.sh:ro",
        '-v', "${Volume}:/mnt/server",
        '-e', 'SGLUNA_INSTALL_ROOT=/mnt/server',
        '-e', 'SGLUNA_ACTOR_MODE=npc',
        '-e', 'SGLUNA_CHAT_PLAYERS=SmokeOperator',
        '-e', "FACTORIO_VERSION=$FactorioSmokeVersion"
    ) + $SourceRefArgs + @(
        $Image,
        'bash', '/tmp/egg-install.sh'
    ))

    Write-Host '[pterodactyl-smoke] Verifying installed release layout.'
    Invoke-Docker -Arguments @(
        'run', '--rm',
        '-v', "${Volume}:/mnt/server",
        $Image,
        'bash', '-lc',
        'set -Eeuo pipefail; test -L /mnt/server/start-sgluna.sh; test "$(readlink /mnt/server/start-airi.sh)" = start-sgluna.sh; test -x /mnt/server/rollback-sgluna.sh; test "$(readlink /mnt/server/rollback-airi.sh)" = rollback-sgluna.sh; test -s /mnt/server/client-mods/autorio_0.1.0.zip; test -s /mnt/server/client-mods/SHA256SUMS; test ! -e /mnt/server/autorio_0.1.0.zip; test -s /mnt/server/sgluna-config.json; test -s /mnt/server/README-SGLUNA.txt; test -d /mnt/server/mods; test -d /mnt/server/saves; ! grep -q smoke-secret /mnt/server/sgluna-config.json; target=$(readlink /mnt/server/start-sgluna.sh); case "$target" in .airi/releases/*/start-sgluna.sh) ;; *) echo "unexpected startup target: $target" >&2; exit 1;; esac; test -s "/mnt/server/${target%/start-sgluna.sh}/manifest.json"'
    )

    Write-Host '[pterodactyl-smoke] Starting packaged runtime with zero connected players.'
    $startedId = Get-DockerOutput -Arguments @(
        'run', '-d', '--name', $Container,
        '-v', "${Volume}:/home/container",
        '-w', '/home/container',
        '-e', 'CONTAINER_ROOT=/home/container',
        '-e', 'SGLUNA_ACTOR_MODE=npc',
        '-e', 'OPENAI_API_KEY=smoke-secret',
        '-e', 'OPENAI_MODEL=smoke-model',
        '-e', 'OPENAI_API_BASEURL=https://api.example.invalid/v1',
        '-e', 'SERVER_PORT=34197',
        $Image,
        'bash', './start-sgluna.sh'
    )
    if ([string]::IsNullOrWhiteSpace($startedId)) {
        throw 'Runtime container did not return a container ID.'
    }

    $ready = $false
    $lastLogs = ''
    for ($i = 0; $i -lt 180; $i++) {
        $lastLogs = (& docker logs $Container 2>&1) -join "`n"
        if ($lastLogs -match 'SGLuna Factorio ready;') {
            $ready = $true
            break
        }

        $running = (& docker inspect -f '{{.State.Running}}' $Container 2>$null) -join ''
        if ($LASTEXITCODE -ne 0 -or $running.Trim() -ne 'true') {
            Write-Host $lastLogs
            throw 'Packaged runtime exited before standalone-NPC readiness.'
        }
        Start-Sleep -Seconds 1
    }

    if (-not $ready) {
        Write-Host $lastLogs
        throw 'Timed out waiting for standalone-NPC readiness.'
    }

    Write-Host '[pterodactyl-smoke] Standalone NPC is ready; requesting graceful save/stop.'
    Invoke-Docker -Arguments @('stop', '--signal=SIGINT', '--time=60', $Container)
    $logs = Get-DockerOutput -Arguments @('logs', $Container)
    Write-Host $logs
    if ($logs -notmatch 'Requesting Factorio graceful /quit shutdown') {
        throw 'Supervisor did not request Factorio /quit.'
    }
    if ($logs -notmatch 'Goodbye') {
        throw 'Factorio clean Goodbye shutdown marker missing.'
    }
    if ($logs -notmatch 'SGLuna Factorio stopped cleanly') {
        throw 'Clean shutdown acknowledgement missing.'
    }

    Write-Host '[pterodactyl-smoke] Verifying a non-empty save exists.'
    Invoke-Docker -Arguments @(
        'run', '--rm',
        '-v', "${Volume}:/home/container",
        $Image,
        'bash', '-lc',
        "find /home/container/saves -maxdepth 1 -type f -name '*.zip' -size +0c | grep -q ."
    )

    Write-Host '[pterodactyl-smoke] PASS: generated PTDL_v2 egg installed, started a zero-player standalone NPC, Factorio said Goodbye after /quit, saved, and stopped cleanly.'
}
finally {
    & docker rm -f $Container *> $null
    & docker volume rm -f $Volume *> $null
    Remove-Item -Force -ErrorAction SilentlyContinue $EggInstallScript
}
