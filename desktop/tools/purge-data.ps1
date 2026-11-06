<#
.SYNOPSIS
  Removes everything One Key has stored on this machine, including the vault.

.DESCRIPTION
  Uninstalling One Key deliberately leaves your vault in place: it is the only
  copy of your passwords, there is no recovery path, and reinstalling to upgrade
  must not destroy it. This script is the deliberate way to remove it anyway -
  before selling the machine, handing it on, or starting over.

  THE VAULT CANNOT BE RECOVERED once deleted. Not by this app, not by anyone.
  Use -Backup first if there is any doubt.

  Runs as a dry run by default and only reports what it would remove. Pass
  -Force to actually delete. Run from an elevated prompt to also clear the
  machine-level Chrome registration.

.PARAMETER Force
  Actually delete. Without this, nothing is removed.

.PARAMETER Backup
  Copy the vault to this folder before deleting. The copy stays encrypted and is
  still useless without your master password.

.EXAMPLE
  # See what would go, change nothing:
  powershell -ExecutionPolicy Bypass -File tools\purge-data.ps1

.EXAMPLE
  # Keep a copy, then remove everything:
  powershell -ExecutionPolicy Bypass -File tools\purge-data.ps1 -Backup D:\safe -Force
#>

[CmdletBinding()]
param(
  [switch]$Force,
  [string]$Backup
)

$ErrorActionPreference = 'Stop'

$HostName  = 'com.onekey.host'
$VaultDir  = Join-Path $env:APPDATA 'One Key'
$UserDir   = Join-Path $env:LOCALAPPDATA 'One Key'
$MachDir   = Join-Path $env:ProgramData 'One Key'
$UserKey   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$MachKey   = "HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"

function Test-Elevated {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole(
    [System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Deleting the vault from under a running app would be a poor idea.
$running = Get-Process 'One Key' -ErrorAction SilentlyContinue
if ($running) {
  Write-Error "One Key is running. Quit it from the tray icon first (right-click -> Quit One Key)."
  exit 1
}

$elevated = Test-Elevated

Write-Output ""
Write-Output "One Key - stored data on this machine"
Write-Output "======================================"

$vaultFile = Join-Path $VaultDir 'vault\vault.onekey'
if (Test-Path $vaultFile) {
  $f = Get-Item $vaultFile
  Write-Output ""
  Write-Output "  YOUR VAULT (unrecoverable once deleted)"
  Write-Output ("    {0}" -f $f.FullName)
  Write-Output ("    {0:N0} bytes, last saved {1}" -f $f.Length, $f.LastWriteTime)
} else {
  Write-Output ""
  Write-Output "  No vault found at $vaultFile"
}

$targets = @()
if (Test-Path $VaultDir) { $targets += @{ Kind = 'dir'; Path = $VaultDir; Note = 'vault + app cache' } }
foreach ($d in @($UserDir, $MachDir)) {
  foreach ($n in @("$HostName.json", 'app-path.txt')) {
    $p = Join-Path $d $n
    if (Test-Path $p) { $targets += @{ Kind = 'file'; Path = $p; Note = 'Chrome bridge' } }
  }
}
if (Test-Path $UserKey) { $targets += @{ Kind = 'reg'; Path = $UserKey; Note = 'Chrome bridge (user)' } }
if (Test-Path $MachKey) { $targets += @{ Kind = 'reg'; Path = $MachKey; Note = 'Chrome bridge (machine, needs admin)' } }

Write-Output ""
Write-Output "  Items that would be removed:"
if ($targets.Count -eq 0) {
  Write-Output "    (nothing - this machine is already clean)"
} else {
  foreach ($t in $targets) { Write-Output ("    [{0}] {1}  -- {2}" -f $t.Kind, $t.Path, $t.Note) }
}

if (-not $Force) {
  Write-Output ""
  Write-Output "  Dry run - nothing was changed."
  Write-Output "  Add -Force to delete. Consider -Backup FOLDER first."
  if (-not $elevated -and (Test-Path $MachKey)) {
    Write-Output "  Note: the machine-level registry key needs an elevated prompt."
  }
  Write-Output ""
  return
}

if ($Backup) {
  if (-not (Test-Path $vaultFile)) {
    Write-Output ""
    Write-Output "  Nothing to back up (no vault present)."
  } else {
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $Backup "vault-$stamp.onekey"
    Copy-Item $vaultFile $dest -Force
    Write-Output ""
    Write-Output "  Backed up to: $dest"
    Write-Output "  (still encrypted - useless without your master password)"
  }
}

Write-Output ""
foreach ($t in $targets) {
  try {
    switch ($t.Kind) {
      'dir'  { Remove-Item -LiteralPath $t.Path -Recurse -Force; Write-Output "  removed  $($t.Path)" }
      'file' { Remove-Item -LiteralPath $t.Path -Force;           Write-Output "  removed  $($t.Path)" }
      'reg'  {
        if ($t.Path -eq $MachKey -and -not $elevated) {
          Write-Output "  SKIPPED  $($t.Path)  (needs an elevated prompt)"
        } else {
          Remove-Item -LiteralPath $t.Path -Recurse -Force
          Write-Output "  removed  $($t.Path)"
        }
      }
    }
  } catch {
    Write-Output "  FAILED   $($t.Path)  -- $($_.Exception.Message)"
  }
}

# These only disappear if nothing else lives in them.
foreach ($d in @($UserDir, $MachDir)) {
  if ((Test-Path $d) -and -not (Get-ChildItem $d -Force -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $d -Force
    Write-Output "  removed  $d"
  }
}

Write-Output ""
Write-Output "Done. Remove the One Key extension from chrome://extensions too, if it is still there."
Write-Output ""
