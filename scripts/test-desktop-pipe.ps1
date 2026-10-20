#Requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This verification requires Windows named pipes.' }
. (Join-Path $PSScriptRoot 'discover-desktop-pipe.ps1') -LibraryOnly

$validPreferred = '\\.\pipe\codex-app-tools-' + [guid]::NewGuid().ToString()
if ((Get-PreferredDesktopPipeName -Path $validPreferred) -ne [IO.Path]::GetFileName($validPreferred)) { throw 'Valid preferred pipe path was rejected.' }
foreach ($path in @('codex-app-tools-00000000-0000-4000-8000-000000000001', '\\remote\pipe\codex-app-tools-00000000-0000-4000-8000-000000000001', '\\.\pipe\other-name', ($validPreferred + '\extra'))) {
    $rejected = $false
    try { Get-PreferredDesktopPipeName -Path $path | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'An invalid preferred pipe path was accepted.' }
}
$failure = & (Get-Command pwsh).Source -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'discover-desktop-pipe.ps1') -AppUserModelId 'unused' -PreferredPipePath '\\remote\pipe\private-endpoint' 2>&1
if ($LASTEXITCODE -ne 1 -or ($failure -join "`n") -ne 'A verified local Codex desktop connection is unavailable.') { throw 'Invalid preferred pipe did not produce the generic failure.' }

$expected = [pscustomobject]@{ executable = 'C:\Installed\Codex\ChatGPT.exe'; sid = 'S-1-5-21-123-456-789-1001'; sessionId = [uint32]1 }
$peer = [pscustomobject]@{ pid = [uint32]123; executable = $expected.executable; startedUtc = '2026-01-01T00:00:00.0000000Z'; sid = $expected.sid; sessionId = [uint32]1; pipeSessionId = [uint32]1 }
if (-not (Test-DesktopPeerIdentity $expected $peer $peer)) { throw 'Matching synthetic peer was rejected.' }
foreach ($scenario in @('sid', 'sessionId', 'pipeSessionId', 'executable', 'pid', 'startedUtc')) {
    $changed = [pscustomobject]@{ pid = $peer.pid; executable = $peer.executable; startedUtc = $peer.startedUtc; sid = $peer.sid; sessionId = $peer.sessionId; pipeSessionId = $peer.pipeSessionId }
    switch ($scenario) {
        'sid' { $changed.sid = 'S-1-5-21-999-999-999-1001' }
        'sessionId' { $changed.sessionId = [uint32]2 }
        'pipeSessionId' { $changed.pipeSessionId = [uint32]2 }
        'executable' { $changed.executable = 'C:\Untrusted\ChatGPT.exe' }
        'pid' { $changed.pid = [uint32]124 }
        'startedUtc' { $changed.startedUtc = '2026-01-01T00:01:00.0000000Z' }
    }
    if (Test-DesktopPeerIdentity $expected $peer $changed) { throw "Changed $scenario was accepted." }
}
if (Test-DesktopPeerIdentity $expected $null $peer) { throw 'Missing process was accepted.' }
if (Get-VerifiedDesktopPipePeer -PipeName 'unrelated-pipe' -Expected $expected) { throw 'Unrelated pipe was accepted.' }
if (Get-VerifiedDesktopPipePeer -PipeName ('codex-app-tools-' + [guid]::NewGuid().ToString()) -Expected $expected) { throw 'Missing pipe was accepted.' }

function Invoke-TestPipe {
    param([scriptblock]$Check)
    $name = 'codex-app-tools-' + [guid]::NewGuid().ToString()
    $server = [IO.Pipes.NamedPipeServerStream]::new($name, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $waiting = $server.BeginWaitForConnection($null, $null)
        & $Check $name
        if (-not $waiting.AsyncWaitHandle.WaitOne(3000)) { throw 'Test pipe did not connect.' }
        $server.EndWaitForConnection($waiting)
    } finally { $server.Dispose() }
}

$current = Get-DesktopPeerProcess -ProcessId ([uint32][Diagnostics.Process]::GetCurrentProcess().Id) -PipeSessionId ([uint32][Diagnostics.Process]::GetCurrentProcess().SessionId)
$ownIdentity = [pscustomobject]@{ executable = $current.executable; sid = $current.sid; sessionId = $current.sessionId }
Invoke-TestPipe {
    param($name)
    $result = Get-VerifiedDesktopPipePeer -PipeName $name -Expected $ownIdentity
    if (-not $result -or $result.serverPid -ne $current.pid -or $result.startedUtc -ne $current.startedUtc) { throw 'Windows peer PID/session/process validation failed.' }
}
Invoke-TestPipe {
    param($name)
    if (Get-VerifiedDesktopPipePeer -PipeName $name -Expected $expected) { throw 'Spoof desktop pipe owned by PowerShell was accepted.' }
}
Write-Host 'PASS: peer SID/session/path/PID reuse guards, real Windows peer identity, spoof/missing pipe rejection, strict preferred-path validation and generic errors. No files or application state changed.'
