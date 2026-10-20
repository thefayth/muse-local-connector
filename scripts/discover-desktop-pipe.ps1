#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$AppUserModelId,
    [string]$PreferredPipePath,
    [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-PreferredDesktopPipeName {
    param([string]$Path)
    if (-not $Path) { return $null }
    if ($Path -notmatch '^\\\\\.\\pipe\\(codex-app-tools-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$') { throw 'Desktop connection unavailable.' }
    return $Matches[1]
}

function Test-DesktopPeerIdentity {
    param($Expected, $Observed, $Rechecked)
    try {
        if (-not $Expected -or -not $Observed -or -not $Rechecked) { return $false }
        if ($Observed.pid -isnot [uint32] -and $Observed.pid -isnot [int]) { return $false }
        if ($Observed.pid -lt 1 -or $Observed.pid -ne $Rechecked.pid) { return $false }
        $expectedPath = [IO.Path]::GetFullPath($Expected.executable)
        foreach ($peer in @($Observed, $Rechecked)) {
            if (-not [IO.Path]::GetFullPath($peer.executable).Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
            if ($peer.sid -cne $Expected.sid -or $peer.sessionId -ne $Expected.sessionId -or $peer.pipeSessionId -ne $Expected.sessionId) { return $false }
        }
        $started = [datetime]::Parse($Observed.startedUtc).ToUniversalTime()
        if ($started -ne [datetime]::Parse($Rechecked.startedUtc).ToUniversalTime() -or $started -gt [datetime]::UtcNow.AddSeconds(5)) { return $false }
        return $true
    } catch { return $false }
}

function Initialize-DesktopPipePeerApi {
    if (-not ('MuseConnector.NativePipePeer' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace MuseConnector {
    public static class NativePipePeer {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint serverSessionId);
    }
}
'@
    }
}

function Get-DesktopPeerProcess {
    param([uint32]$ProcessId, [uint32]$PipeSessionId)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $process -or -not $process.ExecutablePath -or -not $process.CreationDate) { throw 'Desktop peer unavailable.' }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw 'Desktop peer unavailable.' }
    [pscustomobject]@{
        pid = [uint32]$process.ProcessId
        executable = [IO.Path]::GetFullPath($process.ExecutablePath)
        startedUtc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
        sid = $owner.Sid
        sessionId = [uint32]$process.SessionId
        pipeSessionId = $PipeSessionId
    }
}

function Get-InstalledDesktopIdentity {
    param([string]$ApplicationId)
    if ($ApplicationId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}![A-Za-z0-9][A-Za-z0-9._-]{0,99}$') { throw 'Desktop application unavailable.' }
    $parts = $ApplicationId.Split('!')
    $package = @(Get-AppxPackage | Where-Object { $_.PackageFamilyName -ceq $parts[0] })
    if ($package.Count -ne 1) { throw 'Desktop application unavailable.' }
    $manifest = Get-AppxPackageManifest -Package $package[0].PackageFullName
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -ceq $parts[1] })
    if ($application.Count -ne 1) { throw 'Desktop application unavailable.' }
    $root = [IO.Path]::GetFullPath($package[0].InstallLocation).TrimEnd('\') + '\'
    $executable = [IO.Path]::GetFullPath((Join-Path $root $application[0].Executable))
    if (-not $executable.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Desktop application unavailable.' }
    if ((Get-AuthenticodeSignature -LiteralPath $executable).Status -ne 'Valid') { throw 'Desktop application unavailable.' }
    [pscustomobject]@{
        executable = $executable
        sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        sessionId = [uint32][Diagnostics.Process]::GetCurrentProcess().SessionId
    }
}

function Get-VerifiedDesktopPipePeer {
    param([string]$PipeName, $Expected)
    if ($PipeName -notmatch '^codex-app-tools-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { return $null }
    $client = $null
    try {
        Initialize-DesktopPipePeerApi
        $client = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous, [Security.Principal.TokenImpersonationLevel]::Identification)
        $client.Connect(300)
        [uint32]$serverId = 0
        [uint32]$sessionId = 0
        if (-not [MuseConnector.NativePipePeer]::GetNamedPipeServerProcessId($client.SafePipeHandle, [ref]$serverId) -or -not [MuseConnector.NativePipePeer]::GetNamedPipeServerSessionId($client.SafePipeHandle, [ref]$sessionId)) { return $null }
        $observed = Get-DesktopPeerProcess -ProcessId $serverId -PipeSessionId $sessionId
        [uint32]$recheckedId = 0
        [uint32]$recheckedSession = 0
        if (-not [MuseConnector.NativePipePeer]::GetNamedPipeServerProcessId($client.SafePipeHandle, [ref]$recheckedId) -or -not [MuseConnector.NativePipePeer]::GetNamedPipeServerSessionId($client.SafePipeHandle, [ref]$recheckedSession)) { return $null }
        $rechecked = Get-DesktopPeerProcess -ProcessId $recheckedId -PipeSessionId $recheckedSession
        if (-not $client.IsConnected -or -not (Test-DesktopPeerIdentity -Expected $Expected -Observed $observed -Rechecked $rechecked)) { return $null }
        [pscustomobject]@{ pipePath = '\\.\pipe\' + $PipeName; serverPid = $observed.pid; startedUtc = $observed.startedUtc; executable = $observed.executable }
    } catch { return $null }
    finally { if ($client) { $client.Dispose() } }
}

if ($LibraryOnly) { return }
try {
    if (-not $IsWindows) { throw 'Desktop connection unavailable.' }
    $preferredName = Get-PreferredDesktopPipeName -Path $PreferredPipePath
    $expected = Get-InstalledDesktopIdentity -ApplicationId $AppUserModelId
    if ($preferredName) {
        $peer = Get-VerifiedDesktopPipePeer -PipeName $preferredName -Expected $expected
        if ($peer) { $peer | ConvertTo-Json -Compress; exit 0 }
    }
    $names = @([IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object { $_ -match '^codex-app-tools-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' } | Sort-Object | Select-Object -First 64)
    foreach ($name in $names) {
        $peer = Get-VerifiedDesktopPipePeer -PipeName $name -Expected $expected
        if ($peer) { $peer | ConvertTo-Json -Compress; exit 0 }
    }
    throw 'Desktop connection unavailable.'
} catch {
    [Console]::Error.WriteLine('A verified local Codex desktop connection is unavailable.')
    exit 1
}
