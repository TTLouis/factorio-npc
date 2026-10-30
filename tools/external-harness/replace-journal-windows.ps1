param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

# Paths arrive as argv data, never as PowerShell source. No journal contents,
# credentials, provider environment or native error details are printed.
$ErrorActionPreference = 'Stop'
try {
    $sourcePath = [System.IO.Path]::GetFullPath($Source)
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    if ([System.IO.Path]::GetDirectoryName($sourcePath) -cne [System.IO.Path]::GetDirectoryName($destinationPath)) {
        exit 1
    }
    $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($destinationPath))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
        exit 1
    }
    # A root drive check alone misses junctions and mounted volumes. Refuse all
    # reparse components, including existing leaves, rather than guessing the
    # backing filesystem. The state directory must be private to this owner.
    foreach ($candidate in @($sourcePath, $destinationPath)) {
        $component = $candidate
        while ($component) {
            if ([System.IO.File]::Exists($component) -or [System.IO.Directory]::Exists($component)) {
                $attributes = [System.IO.File]::GetAttributes($component)
                if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
            }
            $component = [System.IO.Path]::GetDirectoryName($component)
        }
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExternalHarnessJournalMove {
    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Move(string source, string destination, uint flags);
}
'@
    # REPLACE_EXISTING | WRITE_THROUGH. No COPY_ALLOWED, delayed move or fallback.
    # The caller flushed and closed the source before invoking this helper.
    if (-not [ExternalHarnessJournalMove]::Move($sourcePath, $destinationPath, 9)) {
        exit 1
    }
    exit 0
}
catch { exit 1 }
