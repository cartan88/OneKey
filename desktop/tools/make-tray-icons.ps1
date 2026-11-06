<#
.SYNOPSIS
  Generates the two tray icon states — unlocked and locked — into src\assets.

.DESCRIPTION
  The tray icon needs to be readable at 16x16 in the Windows notification area,
  so this leans on two independent signals rather than one: colour (red = live/
  unlocked, grey = dormant/locked) AND shape (an open key vs. the same closed-
  padlock glyph used elsewhere in the app for "Lock vault"), so the state still
  reads for someone who can't distinguish the colours.

  Re-run this whenever the icons need regenerating; the .ico outputs are
  committed like build\icon.ico, not built on every `npm run dist`.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-TrayBitmap([int]$S, [bool]$Locked) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # --- rounded-square background: brand red when unlocked, muted grey when locked
  $inset = [Math]::Round($S * 0.055)
  $rect = New-Object System.Drawing.Rectangle $inset, $inset, ($S - 2 * $inset), ($S - 2 * $inset)
  $radius = [Math]::Round($S * 0.225)
  $bgPath = New-RoundedRectPath $rect.X $rect.Y $rect.Width $rect.Height $radius

  if ($Locked) {
    $c1 = [System.Drawing.Color]::FromArgb(255, 122, 130, 143)
    $c2 = [System.Drawing.Color]::FromArgb(255, 74, 81, 92)
  } else {
    $c1 = [System.Drawing.Color]::FromArgb(255, 239, 98, 93)
    $c2 = [System.Drawing.Color]::FromArgb(255, 184, 51, 47)
  }
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point $rect.X, $rect.Y),
    (New-Object System.Drawing.Point $rect.Right, $rect.Bottom),
    $c1, $c2)
  $g.FillPath($brush, $bgPath)

  $u = $S / 24.0
  $stroke = [float]($u * 1.9)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $stroke
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  if ($Locked) {
    # Closed padlock — the same glyph the app uses elsewhere for "Lock vault",
    # so the tray icon's shape means the same thing it already means in the UI.
    $bodyX = $u * 4; $bodyY = $u * 10; $bodyW = $u * 16; $bodyH = $u * 11
    $bodyPath = New-RoundedRectPath $bodyX $bodyY $bodyW $bodyH ($u * 2)
    $g.DrawPath($pen, $bodyPath)
    $bodyPath.Dispose()

    # Shackle: two verticals plus the arc joining them, matching path
    # "M8 10 V7 A4 4 0 0 1 16 7 V10" from the sidebar's lock icon.
    $g.DrawLine($pen, [float]($u * 8), [float]($u * 10), [float]($u * 8), [float]($u * 7))
    $g.DrawArc($pen, [float]($u * 8), [float]($u * 3), [float]($u * 8), [float]($u * 8), 180, 180)
    $g.DrawLine($pen, [float]($u * 16), [float]($u * 7), [float]($u * 16), [float]($u * 10))
  } else {
    # Open key — identical glyph to the main app icon.
    $r = $u * 3.55
    $cx = $u * 8.6
    $cy = $u * 12.0
    $g.DrawEllipse($pen, [float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
    $g.DrawLine($pen, [float]($cx + $r - $u * 0.2), [float]$cy, [float]($u * 19.6), [float]$cy)
    $g.DrawLine($pen, [float]($u * 15.9), [float]$cy, [float]($u * 15.9), [float]($cy + $u * 3.6))
    $g.DrawLine($pen, [float]($u * 19.0), [float]$cy, [float]($u * 19.0), [float]($cy + $u * 2.5))
  }

  $pen.Dispose(); $brush.Dispose(); $bgPath.Dispose(); $g.Dispose()
  return $bmp
}

function Save-Ico([bool]$Locked, [string]$Path) {
  $sizes = @(48, 32, 24, 16)
  $pngs = @{}
  foreach ($s in $sizes) {
    $bmp = New-TrayBitmap $s $Locked
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs[$s] = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
  }

  $fs = [System.IO.File]::Create($Path)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
  $offset = 6 + (16 * $sizes.Count)
  foreach ($s in $sizes) {
    $bw.Write([Byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([Byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngs[$s].Length)
    $bw.Write([UInt32]$offset)
    $offset += $pngs[$s].Length
  }
  foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()
}

$unlockedPath = Join-Path $outDir 'tray-unlocked.ico'
$lockedPath = Join-Path $outDir 'tray-locked.ico'
Save-Ico $false $unlockedPath
Save-Ico $true $lockedPath

Write-Output ("Wrote {0} ({1:N0} bytes)" -f $unlockedPath, (Get-Item $unlockedPath).Length)
Write-Output ("Wrote {0} ({1:N0} bytes)" -f $lockedPath, (Get-Item $lockedPath).Length)
