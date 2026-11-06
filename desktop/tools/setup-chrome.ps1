<#
.SYNOPSIS
  Registers One Key as a Chrome native messaging host for the current user.

.DESCRIPTION
  Chrome will only launch a local program on an extension's behalf if that
  program is declared in a manifest whose location is recorded in the registry.
  This writes both.

  By default everything it touches is per-user (HKCU) - no admin rights, and
  nothing machine-wide is modified. Run with -Remove to undo it completely.

  Use -Machine if Chrome reports "Specified native messaging host not found"
  even though the per-user registration is present and correct. Managed Chrome
  profiles can have the NativeMessagingUserLevelHosts policy set to false, which
  makes Chrome ignore HKCU hosts entirely; a machine-level registration is still
  honoured. Check chrome://policy to confirm before reaching for this.
  -Machine requires an elevated prompt.

.PARAMETER AppPath
  Full path to "One Key.exe". Defaults to the installed location, then falls
  back to the dev build under dist\win-unpacked.

.PARAMETER HostPath
  Full path to onekey-host.exe, the small console relay Chrome actually launches.
  Defaults to the copy beside One Key.exe, then to build\onekey-host.exe.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\setup-chrome.ps1

.EXAMPLE
  # From an elevated prompt, when a policy blocks user-level hosts:
  powershell -ExecutionPolicy Bypass -File tools\setup-chrome.ps1 -Machine

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\setup-chrome.ps1 -Remove
#>

[CmdletBinding()]
param(
  [string]$AppPath,
  [string]$HostPath,
  [switch]$Machine,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$HostName    = 'com.onekey.host'
$ExtensionId = 'nofckpbcfemncfcodiedbngfgobfkgok'

$UserRegKey    = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$MachineRegKey = "HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\$HostName"
$UserDir       = Join-Path $env:LOCALAPPDATA 'One Key'
$MachineDir    = Join-Path $env:ProgramData 'One Key'

if ($Machine) {
  $RegKey = $MachineRegKey
  $ManifestDir = $MachineDir
} else {
  $RegKey = $UserRegKey
  $ManifestDir = $UserDir
}
$ManifestPath = Join-Path $ManifestDir "$HostName.json"
$AppPointer   = Join-Path $ManifestDir 'app-path.txt'

function Test-Elevated {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole(
    [System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Machine -and -not (Test-Elevated)) {
  Write-Error @"
-Machine writes to HKLM and %ProgramData%, so it needs an elevated prompt.

Press Win+X, choose "Terminal (Admin)", then run:
  powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -Machine
"@
  exit 1
}

if ($Remove) {
  # Clear both scopes regardless of -Machine, so one -Remove undoes everything.
  foreach ($k in @($UserRegKey, $MachineRegKey)) {
    if (Test-Path $k) {
      if ($k -eq $MachineRegKey -and -not (Test-Elevated)) {
        Write-Output "Skipped (needs admin): $k"
        continue
      }
      Remove-Item $k -Force
      Write-Output "Removed registry key: $k"
    }
  }
  foreach ($d in @($UserDir, $MachineDir)) {
    foreach ($f in @((Join-Path $d "$HostName.json"), (Join-Path $d 'app-path.txt'))) {
      if (Test-Path $f) {
        Remove-Item -LiteralPath $f -Force
        Write-Output "Removed: $f"
      }
    }
  }
  Write-Output "One Key is no longer registered with Chrome. Restart Chrome to apply."
  return
}

# --- locate One Key.exe
if (-not $AppPath) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\One Key\One Key.exe'),
    (Join-Path $PSScriptRoot '..\dist\win-unpacked\One Key.exe')
  )
  foreach ($c in $candidates) {
    $full = [System.IO.Path]::GetFullPath($c)
    if (Test-Path $full) { $AppPath = $full; break }
  }
}

if (-not $AppPath -or -not (Test-Path $AppPath)) {
  Write-Error @"
Could not find "One Key.exe".

Install One Key first, or build it with 'npm run dist', or pass the path:
  .\tools\setup-chrome.ps1 -AppPath "C:\path\to\One Key.exe"
"@
  exit 1
}

$AppPath = [System.IO.Path]::GetFullPath($AppPath)

# --- locate the console relay Chrome will actually launch
if (-not $HostPath) {
  $candidates = @(
    (Join-Path (Split-Path -Parent $AppPath) 'onekey-host.exe'),
    (Join-Path $PSScriptRoot '..\build\onekey-host.exe')
  )
  foreach ($c in $candidates) {
    $full = [System.IO.Path]::GetFullPath($c)
    if (Test-Path $full) { $HostPath = $full; break }
  }
}

if (-not $HostPath -or -not (Test-Path $HostPath)) {
  Write-Error @"
Could not find "onekey-host.exe".

Build it with:
  powershell -ExecutionPolicy Bypass -File tools\build-host.ps1
"@
  exit 1
}

$HostPath = [System.IO.Path]::GetFullPath($HostPath)

# --- write the host manifest
# Chrome launches this helper (not One Key.exe) and passes the caller's origin as
# an argument. It must be a console-subsystem program: Electron's main process
# leaves stdin unwired and emits a stray CRLF on stdout, either of which breaks
# native messaging framing.
New-Item -ItemType Directory -Force $ManifestDir | Out-Null

# Recorded so the helper can start the app when nothing is running yet.
[System.IO.File]::WriteAllText($AppPointer, $AppPath, (New-Object System.Text.UTF8Encoding($false)))

$manifest = [ordered]@{
  name           = $HostName
  description    = 'One Key password manager bridge'
  path           = $HostPath
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$json = $manifest | ConvertTo-Json -Depth 4
# Chrome's JSON parser rejects a UTF-8 BOM here.
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# --- point the registry at it
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name '(Default)' -Value $ManifestPath

$scope = if ($Machine) { 'machine-wide (HKLM)' } else { 'this user (HKCU)' }
Write-Output "One Key registered as a Chrome native messaging host for $scope."
Write-Output ""
Write-Output "  host relay : $HostPath"
Write-Output "  app        : $AppPath"
Write-Output "  manifest   : $ManifestPath"
Write-Output "  registry   : $RegKey"
Write-Output "  extension  : $ExtensionId"
Write-Output ""
Write-Output "Next, load the extension in Chrome:"
Write-Output "  1. Open chrome://extensions"
Write-Output "  2. Turn on Developer mode (top right)"
Write-Output "  3. Load unpacked -> select the 'extension' folder in this project"
Write-Output ""
Write-Output "Then open One Key, unlock your vault, and the extension is live."
Write-Output "Undo any time with: .\tools\setup-chrome.ps1 -Remove"
