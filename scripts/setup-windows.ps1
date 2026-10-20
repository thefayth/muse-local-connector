#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MuseLocalConnector'),
    [Alias('AllowedThreadIds')][string[]]$PilotThreadId = @(),
    [ValidateRange(1024, 65535)][int]$Port = 18761,
    [ValidateRange(1, 32)][int]$MaxConcurrentJobs = 4,
    [string]$VaultModulePath = (Join-Path $env:USERPROFILE '.codex\secure-vault\CodexVault.psm1'),
    [switch]$CopyKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This setup requires Windows and PowerShell 7.2 or later.' }
. (Join-Path $PSScriptRoot 'credential-store.ps1')

$DataDir = [IO.Path]::GetFullPath($DataDir)
$configPath = Join-Path $DataDir 'config.json'
$existingConfig = $null
if (Test-Path -LiteralPath $configPath) { $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
if (-not (Test-Path -LiteralPath $configPath)) {
    if ([string]::IsNullOrWhiteSpace($env:CODEX_THREAD_ID)) {
        throw 'Run initial setup from a Codex terminal with CODEX_THREAD_ID available.'
    }
    if (@($PilotThreadId | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -eq 0) {
        throw 'Supply -PilotThreadId with the existing Codex chat selected for the first verification.'
    }
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $DataDir /inheritance:r /grant:r "*${userSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the connector data directory.' }
$storeMetadata = $null
if ($existingConfig -and $existingConfig.PSObject.Properties.Name -contains 'credentialStore') { $storeMetadata = $existingConfig.credentialStore }
$credentialStore = Get-ConnectorCredentialStore -DataDir $DataDir -VaultModulePath $VaultModulePath -Metadata $storeMetadata
if (-not (Test-ConnectorCredential -Store $credentialStore -DataDir $DataDir)) {
    if ($existingConfig) { throw 'The configured credential is missing. Restore the credential before changing the existing configuration.' }
    $randomBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $newToken = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $newSecureToken = ConvertTo-SecureString $newToken -AsPlainText -Force
    try { Write-ConnectorCredential -Store $credentialStore -DataDir $DataDir -Secret $newSecureToken } finally { $newSecureToken.Dispose() }
    [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    $newToken = $null
}

$secureToken = Read-ConnectorCredential -Store $credentialStore -DataDir $DataDir
$tokenPointer = [IntPtr]::Zero
try {
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    $tokenBytes = [Text.Encoding]::UTF8.GetBytes($tokenText)
    $tokenSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($tokenBytes)).ToLowerInvariant()
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    if (Test-Path -LiteralPath $configPath) {
        if ($existingConfig.tokenSha256 -cne $tokenSha256) {
            throw 'The existing configuration does not match the vault key. Review key rotation before replacing either value.'
        }
        Write-Host "Existing configuration preserved: $configPath"
    } else {
        $configuration = [ordered]@{
            configVersion = 1
            host = '127.0.0.1'
            port = $Port
            dataDir = $DataDir
            tokenSha256 = $tokenSha256
            credentialStore = $credentialStore
            controllerThreadId = $env:CODEX_THREAD_ID
            allowedThreadIds = @($PilotThreadId | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
            allowAllTasks = $false
            maxConcurrentJobs = $MaxConcurrentJobs
            publicOrigin = $null
        }
        $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
        Write-Host "Pilot configuration saved: $configPath"
    }
    if ($CopyKey) {
        Set-Clipboard -Value $tokenText
        Write-Host 'API key copied to the Windows clipboard. Paste only into the Muse secure credential field; clear the clipboard afterward.'
    }
} finally {
    $tokenText = $null
    if ($tokenPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
    $secureToken.Dispose()
}
Write-Host 'Setup did not start the connector, a tunnel, a service, or a scheduled task.'
