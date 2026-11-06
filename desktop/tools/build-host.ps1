<#
.SYNOPSIS
  Compiles the Chrome native messaging host (tools\host\OneKeyHost.cs) into
  build\onekey-host.exe.

.DESCRIPTION
  Uses the C# compiler that ships with the .NET Framework on every Windows 10
  and 11 machine, so there is no toolchain to install. Run as part of
  'npm run dist', or on its own for development.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'host\OneKeyHost.cs'
$outDir = Join-Path $root 'build'
$output = Join-Path $outDir 'onekey-host.exe'

if (-not (Test-Path $source)) { Write-Error "Missing source: $source"; exit 1 }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  Write-Error "Could not find the .NET Framework C# compiler (csc.exe). Install .NET Framework 4.x."
  exit 1
}

if (Test-Path $output) { Remove-Item -LiteralPath $output -Force }

# /target:exe gives a console subsystem binary, which is what makes stdio work
# properly - the whole reason this helper exists.
& $csc /nologo /target:exe /platform:anycpu /optimize+ /warn:4 `
  "/out:$output" `
  '/reference:System.dll' `
  $source

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $output)) {
  Write-Error "Compilation failed (exit $LASTEXITCODE)."
  exit 1
}

$size = (Get-Item $output).Length
Write-Output ("Built {0} ({1:N0} bytes)" -f $output, $size)
