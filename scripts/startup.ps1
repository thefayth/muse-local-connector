#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$NodePath,
    [string]$CodexAppUserModelId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This startup launcher requires Windows.' }
$Config = (Resolve-Path -LiteralPath $Config).Path
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if ($CodexAppUserModelId) {
    if ($CodexAppUserModelId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}![A-Za-z0-9][A-Za-z0-9._-]{0,99}$') { throw 'Supply a valid installed Codex AppUserModelID.' }
    $configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($configuration.controllerThreadId -notmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Startup requires the original controller chat UUID.' }
    $parts = $CodexAppUserModelId.Split('!')
    $package = @(Get-AppxPackage | Where-Object { $_.PackageFamilyName -ceq $parts[0] })
    if ($package.Count -ne 1) { throw 'The configured Codex application package is not installed for this user.' }
    $manifest = Get-AppxPackageManifest -Package $package[0].PackageFullName
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -ceq $parts[1] })
    if ($application.Count -ne 1) { throw 'The configured Codex application is missing from its installed manifest.' }
    $packageRoot = [IO.Path]::GetFullPath($package[0].InstallLocation).TrimEnd('\') + '\'
    $executable = [IO.Path]::GetFullPath((Join-Path $packageRoot $application[0].Executable))
    if (-not $executable.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'The installed Codex executable could not be resolved safely.' }
    # Use the current installed manifest rather than a stale protocol registry path.
    Start-Process -FilePath $executable -ArgumentList @('--single-argument', ('codex://threads/' + $configuration.controllerThreadId)) -WindowStyle Hidden | Out-Null
}
$supervisor = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src\supervisor.mjs')).Path
& $NodePath $supervisor --config $Config
exit $LASTEXITCODE
