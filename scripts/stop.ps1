#Requires -Version 7.2
[CmdletBinding()]
param(
    [Alias('ConfigPath')][string]$Config,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MuseLocalConnector'),
    [switch]$KeepTunnel
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This launcher requires Windows and PowerShell 7.2 or later.' }
if ([string]::IsNullOrWhiteSpace($Config)) { $Config = Join-Path $DataDir 'config.json' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$DataDir = [IO.Path]::GetFullPath($configuration.dataDir)
$sourcePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\cli.mjs')).Path

if (Test-Path -LiteralPath (Join-Path $DataDir 'supervisor-process.json')) {
    if ($KeepTunnel) { throw 'Supervised startup manages the gateway and relay together. Omit -KeepTunnel to stop this installation.' }
    $supervisorPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\supervisor.mjs')).Path
    $supervisorRecord = Get-Content -LiteralPath (Join-Path $DataDir 'supervisor-process.json') -Raw | ConvertFrom-Json
    if ($supervisorRecord.configPath -ine $Config) { throw 'The supervisor belongs to another configuration; it was left running.' }
    & $supervisorRecord.executable $supervisorPath stop --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'The supervisor could not be stopped safely. Inspect its private log.' }
    Write-Host 'Stopped the supervised connector and relay.'
    return
}

function Stop-TrackedProcess {
    param([string]$RecordPath, [string]$ExpectedName, [string[]]$ExpectedArguments)
    if (-not (Test-Path -LiteralPath $RecordPath)) { return }
    $record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
    if ($record.configPath -ine $Config) { throw 'Tracked process belongs to another configuration; it was left running.' }
    $running = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if (-not $running) {
        Remove-Item -LiteralPath $RecordPath
        return
    }
    if ($running.Name -ine $ExpectedName -or $running.ExecutablePath -ine $record.executable) {
        throw 'A tracked PID now belongs to an unrelated process; it was left running.'
    }
    if ([Math]::Abs((([DateTime]$running.CreationDate).ToUniversalTime() - ([DateTime]$record.startedUtc).ToUniversalTime()).TotalSeconds) -gt 2) {
        throw 'A tracked PID has been reused; it was left running.'
    }
    foreach ($argument in $ExpectedArguments) {
        if ($running.CommandLine -notmatch ('(?i)(?:^|[\s"])' + [regex]::Escape($argument) + '(?=$|[\s"])')) {
            throw 'A tracked process command does not match this connector; it was left running.'
        }
    }
    Stop-Process -Id $running.ProcessId -ErrorAction Stop
    Remove-Item -LiteralPath $RecordPath
    Write-Host "Stopped tracked $ExpectedName process $($running.ProcessId)."
}

if (-not $KeepTunnel) {
    Stop-TrackedProcess -RecordPath (Join-Path $DataDir 'tunnel-process.json') -ExpectedName 'cloudflared.exe' -ExpectedArguments @("http://127.0.0.1:$($configuration.port)", (Join-Path $DataDir 'tunnel.log'))
}
Stop-TrackedProcess -RecordPath (Join-Path $DataDir 'connector-process.json') -ExpectedName 'node.exe' -ExpectedArguments @($sourcePath, $Config)
