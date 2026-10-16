#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Config,
    [string]$NodePath,
    [string]$CodexAppUserModelId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This installer requires Windows.' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$dataPath = [IO.Path]::GetFullPath($configuration.dataDir)
if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) { throw 'Run connector setup before installing startup.' }
if (-not $NodePath) { $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$pwshPath = (Resolve-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe')).Path
$startupPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'startup.ps1')).Path
if ($CodexAppUserModelId -and $CodexAppUserModelId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}![A-Za-z0-9][A-Za-z0-9._-]{0,99}$') { throw 'Supply a valid installed Codex AppUserModelID.' }
$configHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant()))).ToLowerInvariant()
$taskName = 'MuseLocalConnector-' + $configHash.Substring(0, 12)
$description = 'MuseLocalConnectorStartup:v1:' + $configHash
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Config "{1}" -NodePath "{2}"' -f $startupPath, $Config, $NodePath
if ($CodexAppUserModelId) { $arguments += ' -CodexAppUserModelId "{0}"' -f $CodexAppUserModelId }
$recordPath = Join-Path $dataPath 'startup-task.json'
$existingTask = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    if (-not (Test-Path -LiteralPath $recordPath)) { throw 'A task with this name exists without this installation record. It was left unchanged.' }
    $previous = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    # Windows can return a SID, full account name, or local short account name.
    $principalSid = if ($existingTask.Principal.UserId -match '^S-1-') { $existingTask.Principal.UserId } else { ([Security.Principal.NTAccount]::new($existingTask.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($previous.configPath -ine $Config -or $existingTask.Description -cne $description -or $principalSid -cne $userSid) { throw 'The existing task does not belong to this installation. It was left unchanged.' }
    if (@($existingTask.Actions).Count -ne 1 -or $existingTask.Actions[0].Execute -ine $previous.actionExecutable -or $existingTask.Actions[0].Arguments -cne $previous.actionArguments) { throw 'The existing startup action has changed. It was left unchanged.' }
    if ($existingTask.State -eq 'Running') { throw 'Stop the installed supervisor before replacing its running startup task.' }
}
if ($PSCmdlet.ShouldProcess($taskName, 'Install current-user logon startup')) {
    $action = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userSid
    $principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
    Register-ScheduledTask -TaskPath '\' -TaskName $taskName -InputObject $definition -Force | Out-Null
    [ordered]@{
        taskName = $taskName; taskPath = '\'; description = $description; configPath = $Config
        userSid = $userSid; userName = $identity.Name; actionExecutable = $pwshPath; actionArguments = $arguments
        nodePath = $NodePath; supervisorPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\supervisor.mjs')).Path
        installedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
    Write-Host "Installed current-user logon task: $taskName"
    Write-Host 'Installation does not start the task or replay existing jobs.'
}
