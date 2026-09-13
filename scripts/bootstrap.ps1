[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-Usage {
    @"
Usage: pwsh -File ./scripts/bootstrap.ps1 [-SkipDeps]

Installs this repo's shared Pi setup into `$env:PI_CODING_AGENT_DIR or ~/.pi/agent.
Existing managed paths are moved into a timestamped backup before linking.
"@ | Write-Output
}

if ($Help) {
    Show-Usage
    exit 0
}

$RootDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PiDir = if ([string]::IsNullOrWhiteSpace($env:PI_CODING_AGENT_DIR)) {
    Join-Path ([Environment]::GetFolderPath("UserProfile")) ".pi/agent"
} else {
    [System.IO.Path]::GetFullPath($env:PI_CODING_AGENT_DIR)
}
$LocalSettings = Join-Path $RootDir "config/settings.local.json"
$script:BackupRoot = $null
$script:PiPrefix = $PiDir.TrimEnd([char[]]@("\", "/")) + [System.IO.Path]::DirectorySeparatorChar
$pathComparison = if ($IsWindows) {
    [System.StringComparison]::OrdinalIgnoreCase
} else {
    [System.StringComparison]::Ordinal
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to merge Pi settings."
}

New-Item -ItemType Directory -Path $PiDir -Force | Out-Null

& node `
    (Join-Path $RootDir "scripts/merge-settings.mjs") `
    (Join-Path $RootDir "config/settings.shared.json") `
    $LocalSettings `
    (Join-Path $PiDir "settings.json")
if ($LASTEXITCODE -ne 0) {
    throw "Could not merge Pi settings (node exited with $LASTEXITCODE)."
}

Write-Output "Updated $(Join-Path $PiDir 'settings.json')"

function Get-PathItem {
    param([Parameter(Mandatory)][string]$Path)

    Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Test-SameLink {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )

    $item = Get-PathItem -Path $Target
    if ($null -eq $item) { return $false }

    $linkType = $item.PSObject.Properties["LinkType"]
    $linkTarget = $item.PSObject.Properties["Target"]
    if ($null -eq $linkType -or $null -eq $linkType.Value -or $null -eq $linkTarget) {
        return $false
    }

    $targetValue = @($linkTarget.Value)[0]
    if ([string]::IsNullOrWhiteSpace($targetValue)) { return $false }

    $resolvedTarget = if ([System.IO.Path]::IsPathRooted($targetValue)) {
        [System.IO.Path]::GetFullPath($targetValue)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Target) $targetValue))
    }

    [string]::Equals(
        [System.IO.Path]::GetFullPath($Source),
        $resolvedTarget,
        $pathComparison
    )
}

function Test-SameFile {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )

    $sourceItem = Get-PathItem -Path $Source
    $targetItem = Get-PathItem -Path $Target
    if ($null -eq $sourceItem -or $null -eq $targetItem) { return $false }
    if ($sourceItem.PSIsContainer -or $targetItem.PSIsContainer) { return $false }

    $linkType = $targetItem.PSObject.Properties["LinkType"]
    if ($null -ne $linkType -and $null -ne $linkType.Value) { return $false }

    (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -eq
        (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
}

function Backup-Target {
    param([Parameter(Mandatory)][string]$Target)

    $relativePath = $Target.Substring($script:PiPrefix.Length)
    if ($null -eq $script:BackupRoot) {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
        $script:BackupRoot = Join-Path $PiDir "backups/$timestamp"
    }

    $destination = Join-Path $script:BackupRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Move-Item -LiteralPath $Target -Destination $destination
    Write-Output "Backed up $relativePath"
}

function Install-ManagedPath {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )

    $relativePath = $Target.Substring($script:PiPrefix.Length)
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null

    if (Test-SameLink -Source $Source -Target $Target) {
        Write-Output "Already linked $relativePath"
        return
    }

    if (Test-SameFile -Source $Source -Target $Target) {
        Write-Output "Already copied $relativePath"
        return
    }

    if ($null -ne (Get-PathItem -Path $Target)) {
        Backup-Target -Target $Target
    }

    try {
        New-Item -ItemType SymbolicLink -Path $Target -Target $Source | Out-Null
        Write-Output "Linked $relativePath"
        return
    } catch {
        $linkError = $_
        $partialTarget = Get-PathItem -Path $Target
        if ($null -ne $partialTarget) {
            Remove-Item -LiteralPath $Target -Force
        }

        $sourceItem = Get-PathItem -Path $Source
        if ($sourceItem.PSIsContainer) {
            try {
                New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
                Write-Output "Junctioned $relativePath (symbolic links are unavailable)"
                return
            } catch {
                throw "Could not link $relativePath. Enable Windows Developer Mode or run PowerShell as Administrator. Symbolic-link error: $linkError Junction error: $_"
            }
        }

        Copy-Item -LiteralPath $Source -Destination $Target
        Write-Output "Copied $relativePath (symbolic links are unavailable)"
    }
}

foreach ($resourceType in @("extensions", "skills", "prompts", "themes")) {
    $sourceDirectory = Join-Path $RootDir $resourceType
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { continue }

    foreach ($sourceItem in Get-ChildItem -LiteralPath $sourceDirectory -Force | Sort-Object Name) {
        $target = Join-Path (Join-Path $PiDir $resourceType) $sourceItem.Name

        if (
            "$resourceType/$($sourceItem.Name)" -eq "extensions/context7" -and
            -not (Test-Path -LiteralPath (Join-Path $sourceItem.FullName "config.json")) -and
            (Test-Path -LiteralPath (Join-Path $target "config.json") -PathType Leaf)
        ) {
            Copy-Item `
                -LiteralPath (Join-Path $target "config.json") `
                -Destination (Join-Path $sourceItem.FullName "config.json")
            Write-Output "Migrated the existing Context7 config (kept ignored by Git)"
        }

        Install-ManagedPath -Source $sourceItem.FullName -Target $target
    }
}

if (-not $SkipDeps) {
    $extensionRoot = Join-Path $RootDir "extensions"
    foreach ($extension in Get-ChildItem -LiteralPath $extensionRoot -Directory | Sort-Object Name) {
        $manifest = Join-Path $extension.FullName "package.json"
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }

        if (
            (Test-Path -LiteralPath (Join-Path $extension.FullName "pnpm-lock.yaml") -PathType Leaf) -and
            (Get-Command pnpm -ErrorAction SilentlyContinue)
        ) {
            Write-Output "Installing dependencies for $($extension.Name) with pnpm"
            & pnpm --dir $extension.FullName install --frozen-lockfile
        } else {
            Write-Output "Installing dependencies for $($extension.Name) with npm"
            & npm --prefix $extension.FullName install --omit=dev --ignore-scripts
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Dependency installation failed for $($extension.Name) (exit code $LASTEXITCODE)."
        }
    }
}

if ($null -ne $script:BackupRoot) {
    Write-Output "Backups: $script:BackupRoot"
}

Write-Output "Pi setup installed. Restart Pi so it can load the resources and packages."
