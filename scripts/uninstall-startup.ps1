#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$Config)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This uninstaller requires Windows.' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$dataPath = [IO.Path]::GetFullPath($configuration.dataDir)
$recordPath = Join-Path $dataPath 'startup-task.json'
if (-not (Test-Path -LiteralPath $recordPath)) { throw 'No startup installation record was found. No task was changed.' }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$configHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).ToLowerInvariant()
if ($record.configPath -ine $Config -or $record.userSid -cne $identity.User.Value -or $record.taskPath -cne '\' -or $record.taskName -cne ('MuseLocalConnector-' + $configHash.Substring(0, 12)) -or $record.description -cne ('MuseLocalConnectorStartup:v1:' + $configHash)) { throw 'The startup record does not belong to this user/configuration. No task was changed.' }
$task = Get-ScheduledTask -TaskPath $record.taskPath -TaskName $record.taskName -ErrorAction SilentlyContinue
if ($task) {
    $principalSid = if ($task.Principal.UserId -match '^S-1-') { $task.Principal.UserId } else { ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($task.Description -cne $record.description -or $principalSid -cne $record.userSid -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $record.actionExecutable -or $task.Actions[0].Arguments -cne $record.actionArguments) { throw 'The startup task identity or action has changed. It was left unchanged.' }
}
$supervisor = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\supervisor.mjs')).Path
if ($record.supervisorPath -ine $supervisor) { throw 'Use the original installation to uninstall this task.' }
if ($PSCmdlet.ShouldProcess($record.taskName, 'Stop owned supervisor and remove current-user logon task')) {
    if (Test-Path -LiteralPath (Join-Path $dataPath 'supervisor-process.json')) {
        & $record.nodePath $supervisor stop --config $Config
        if ($LASTEXITCODE -ne 0) { throw 'Supervisor did not stop safely. The startup task was preserved.' }
    }
    if ($task) {
        Stop-ScheduledTask -TaskPath $record.taskPath -TaskName $record.taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskPath $record.taskPath -TaskName $record.taskName -Confirm:$false
    }
    $record | Add-Member -NotePropertyName uninstalledAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
    Write-Host 'Owned startup task removed. Credentials, configuration, jobs, and logs were preserved.'
}
