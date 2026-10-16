#Requires -Version 7.2

function Get-ConnectorCredentialStore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DataDir,
        [string]$VaultModulePath,
        [object]$Metadata
    )
    if (-not $IsWindows) { throw 'The credential store requires Windows DPAPI.' }
    $secretName = 'muse-codex-local.api-key'
    if ($Metadata -and $Metadata.kind -eq 'codex-vault') {
        if ($Metadata.PSObject.Properties.Name -contains 'modulePath') { $VaultModulePath = $Metadata.modulePath }
        if (-not (Test-Path -LiteralPath $VaultModulePath -PathType Leaf)) {
            throw 'The configured CodexVault module is missing. Restore it before accessing the existing credential.'
        }
    } elseif ($Metadata -and $Metadata.kind -ne 'windows-dpapi') {
        throw 'The configured credential-store kind is unsupported.'
    }
    if (($Metadata -and $Metadata.kind -eq 'codex-vault') -or
        (-not $Metadata -and -not [string]::IsNullOrWhiteSpace($VaultModulePath) -and (Test-Path -LiteralPath $VaultModulePath -PathType Leaf))) {
        $modulePath = (Resolve-Path -LiteralPath $VaultModulePath).Path
        Import-Module $modulePath -Force -Global
        return [pscustomobject]@{ kind = 'codex-vault'; secretName = $secretName; modulePath = $modulePath }
    }
    return [pscustomobject]@{ kind = 'windows-dpapi'; secretName = $secretName }
}

function Test-ConnectorCredential {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Store, [Parameter(Mandatory)][string]$DataDir)
    if ($Store.kind -eq 'codex-vault') { return $Store.secretName -in @(Get-CodexSecretNames) }
    return Test-Path -LiteralPath (Join-Path $DataDir "$($Store.secretName).dpapi") -PathType Leaf
}

function Write-ConnectorCredential {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Store,
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][SecureString]$Secret
    )
    if (Test-ConnectorCredential -Store $Store -DataDir $DataDir) {
        throw 'The connector credential already exists and was preserved.'
    }
    if ($Store.kind -eq 'codex-vault') {
        Set-CodexSecret -Name $Store.secretName -Secret $Secret
        return
    }
    $secretPath = Join-Path $DataDir "$($Store.secretName).dpapi"
    $encryptedBytes = [Text.Encoding]::UTF8.GetBytes(($Secret | ConvertFrom-SecureString))
    $secretFile = [IO.File]::Open($secretPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $secretFile.Write($encryptedBytes, 0, $encryptedBytes.Length) } finally { $secretFile.Dispose() }
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $secretPath /inheritance:r /grant:r "*${userSid}:F" '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the encrypted connector credential.' }
}

function Read-ConnectorCredential {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Store, [Parameter(Mandatory)][string]$DataDir)
    if ($Store.kind -eq 'codex-vault') { return Get-CodexSecret -Name $Store.secretName }
    $secretPath = Join-Path $DataDir "$($Store.secretName).dpapi"
    $serialized = (Get-Content -LiteralPath $secretPath -Raw).TrimEnd("`r", "`n")
    return ConvertTo-SecureString $serialized
}
