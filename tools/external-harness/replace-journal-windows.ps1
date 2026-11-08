param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)
# Compatibility path; forward named data arguments without reinterpreting them.
& (Join-Path $PSScriptRoot '../../deploy/pterodactyl/runtime-v8/replace-journal-windows.ps1') -Source $Source -Destination $Destination
exit $LASTEXITCODE
