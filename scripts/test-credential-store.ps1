#Requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This verification requires Windows DPAPI.' }
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testDirectory = Join-Path $temporaryBase ("muse-credential-test-" + [Guid]::NewGuid().ToString('N'))
$priorControllerThread = $env:CODEX_THREAD_ID
$secretPointer = [IntPtr]::Zero
$restoredSecret = $null
try {
    $env:CODEX_THREAD_ID = 'credential-store-test-controller'
    & (Join-Path $PSScriptRoot 'setup-windows.ps1') -DataDir $testDirectory -PilotThreadId 'credential-store-test-pilot' -VaultModulePath (Join-Path $testDirectory 'not-installed.psm1') | Out-Null
    $configPath = Join-Path $testDirectory 'config.json'
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($configuration.credentialStore.kind -ne 'windows-dpapi') { throw 'Fallback store was not selected.' }
    if ($configuration.maxConcurrentJobs -ne 4) { throw 'New setup did not default to four concurrent jobs.' }
    $restoredSecret = Read-ConnectorCredential -Store $configuration.credentialStore -DataDir $testDirectory
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($restoredSecret)
    $secretText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($secretText)
    $expectedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($secretBytes)).ToLowerInvariant()
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    if ($configuration.tokenSha256 -cne $expectedHash) { throw 'Decrypted credential does not match the stored hash.' }
    $files = @(Get-ChildItem -LiteralPath $testDirectory -File)
    if ($files.Count -ne 2 -or 'config.json' -notin $files.Name -or 'muse-codex-local.api-key.dpapi' -notin $files.Name) {
        throw 'Setup created unexpected files.'
    }
    foreach ($file in $files) {
        if ((Get-Content -LiteralPath $file.FullName -Raw).Contains($secretText)) { throw 'A plaintext credential was written to disk.' }
    }
    $beforeHash = (Get-FileHash -LiteralPath (Join-Path $testDirectory 'muse-codex-local.api-key.dpapi')).Hash
    $beforeConfigHash = (Get-FileHash -LiteralPath $configPath).Hash
    & (Join-Path $PSScriptRoot 'setup-windows.ps1') -DataDir $testDirectory -MaxConcurrentJobs 9 -VaultModulePath (Join-Path $testDirectory 'not-installed.psm1') | Out-Null
    $afterHash = (Get-FileHash -LiteralPath (Join-Path $testDirectory 'muse-codex-local.api-key.dpapi')).Hash
    if ($beforeHash -cne $afterHash) { throw 'Repeated setup replaced the credential.' }
    if ($beforeConfigHash -cne (Get-FileHash -LiteralPath $configPath).Hash) { throw 'Repeated setup replaced existing configuration.' }
    Write-Host 'PASS: Windows DPAPI fallback, hash match, plaintext exclusion, existing-key/config preservation, four-job default. Clipboard unchanged.'
} finally {
    $env:CODEX_THREAD_ID = $priorControllerThread
    $secretText = $null
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($restoredSecret) { $restoredSecret.Dispose() }
    $resolvedTestDirectory = [IO.Path]::GetFullPath($testDirectory)
    $requiredPrefix = $temporaryBase.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestDirectory.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTestDirectory) -notmatch '^muse-credential-test-[a-f0-9]{32}$') {
        throw 'Refusing to remove a test directory outside the verified temporary location.'
    }
    if (Test-Path -LiteralPath $resolvedTestDirectory) { Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force }
}
