#Requires -Version 7.2
[CmdletBinding()]
param(
    [Alias('ConfigPath')][string]$Config,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MuseLocalConnector'),
    [string]$NodePath,
    [switch]$Tunnel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This launcher requires Windows and PowerShell 7.2 or later.' }
if ([string]::IsNullOrWhiteSpace($env:CODEX_APP_TOOLS_PIPE_PATH) -or [string]::IsNullOrWhiteSpace($env:CODEX_THREAD_ID)) {
    throw 'Run this launcher from Codex with CODEX_APP_TOOLS_PIPE_PATH and CODEX_THREAD_ID inherited. Do not copy these values into chat.'
}
if ([string]::IsNullOrWhiteSpace($Config)) { $Config = Join-Path $DataDir 'config.json' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$DataDir = [IO.Path]::GetFullPath($configuration.dataDir)
if ($configuration.controllerThreadId -cne $env:CODEX_THREAD_ID) {
    throw 'This configuration belongs to a different controller chat. Start it from that Codex chat.'
}
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { throw 'The configured private data directory is missing. Run setup first.' }
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$sourcePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\cli.mjs')).Path
$pidPath = Join-Path $DataDir 'connector-process.json'

function Get-TrackedProcess {
    param([string]$RecordPath, [string]$ExpectedName, [string[]]$ExpectedArguments)
    if (-not (Test-Path -LiteralPath $RecordPath)) { return $null }
    $record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
    $running = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if (-not $running) { return $null }
    if ($running.Name -ine $ExpectedName -or $running.ExecutablePath -ine $record.executable) {
        throw 'A tracked PID now belongs to an unrelated process. No process was changed.'
    }
    if ([Math]::Abs((([DateTime]$running.CreationDate).ToUniversalTime() - ([DateTime]$record.startedUtc).ToUniversalTime()).TotalSeconds) -gt 2) {
        throw 'A tracked PID has been reused. No process was changed.'
    }
    foreach ($argument in $ExpectedArguments) {
        if ($running.CommandLine -notmatch ('(?i)(?:^|[\s"])' + [regex]::Escape($argument) + '(?=$|[\s"])')) {
            throw 'A tracked process command does not match this connector. No process was changed.'
        }
    }
    return $running
}

$running = Get-TrackedProcess -RecordPath $pidPath -ExpectedName 'node.exe' -ExpectedArguments @($sourcePath, $Config)
if ($running) {
    Write-Host "Connector already running with tracked PID $($running.ProcessId)."
} else {
    $stdoutPath = Join-Path $DataDir 'connector.stdout.log'
    $stderrPath = Join-Path $DataDir 'connector.stderr.log'
    $arguments = '"{0}" --config "{1}"' -f $sourcePath, $Config
    $process = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory (Split-Path $sourcePath -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $record = [ordered]@{
        pid = $process.Id
        startedUtc = $process.StartTime.ToUniversalTime().ToString('o')
        executable = $NodePath
        scriptPath = $sourcePath
        configPath = $Config
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8NoBOM
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "Connector exited during startup. Inspect the private log: $stderrPath" }
    Write-Host "Connector started on http://127.0.0.1:$($configuration.port) with tracked PID $($process.Id)."
}

if ($Tunnel) {
    $tunnelPidPath = Join-Path $DataDir 'tunnel-process.json'
    $tunnelLogPath = Join-Path $DataDir 'tunnel.log'
    $origin = "http://127.0.0.1:$($configuration.port)"
    $runningTunnel = Get-TrackedProcess -RecordPath $tunnelPidPath -ExpectedName 'cloudflared.exe' -ExpectedArguments @($origin, $tunnelLogPath)
    if ($runningTunnel) {
        Write-Host "Tunnel already running with tracked PID $($runningTunnel.ProcessId)."
    } else {
        $cloudflaredPath = (Get-Command cloudflared -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $tunnelArguments = 'tunnel --url "{0}" --no-autoupdate --logfile "{1}"' -f $origin, $tunnelLogPath
        $tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList $tunnelArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDir 'tunnel.stdout.log') -RedirectStandardError (Join-Path $DataDir 'tunnel.stderr.log')
        [ordered]@{
            pid = $tunnelProcess.Id
            startedUtc = $tunnelProcess.StartTime.ToUniversalTime().ToString('o')
            executable = $cloudflaredPath
            origin = $origin
            logPath = $tunnelLogPath
            configPath = $Config
        } | ConvertTo-Json | Set-Content -LiteralPath $tunnelPidPath -Encoding utf8NoBOM
        Start-Sleep -Milliseconds 500
        $tunnelProcess.Refresh()
        if ($tunnelProcess.HasExited) { throw 'The tunnel exited during startup. Inspect its private logs in the configured data directory.' }
        Write-Host "Temporary HTTPS tunnel started with tracked PID $($tunnelProcess.Id). The generated address is in $tunnelLogPath"
    }
}
