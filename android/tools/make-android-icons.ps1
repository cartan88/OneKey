<#
.SYNOPSIS
  Generates ic_launcher / ic_launcher_round PNGs for every mipmap density.

.DESCRIPTION
  Same red rounded-square + open-key glyph as the desktop app's tray icon and
  window icon, so the brand reads the same on both platforms.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$resDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'app\src\main\res'

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

function New-IconBitmap([int]$S, [bool]$Round) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $bgPath = if ($Round) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse(0, 0, $S, $S)
    $p
  } else {
    New-RoundedRectPath 0 0 $S $S ([Math]::Round($S * 0.225))
  }

  $c1 = [System.Drawing.Color]::FromArgb(255, 239, 98, 93)
  $c2 = [System.Drawing.Color]::FromArgb(255, 184, 51, 47)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 0, 0),
    (New-Object System.Drawing.Point $S, $S),
    $c1, $c2)
  $g.FillPath($brush, $bgPath)

  $u = $S / 24.0
  $stroke = [float]($u * 1.9)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $stroke
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $r = $u * 3.55
  $cx = $u * 8.6
  $cy = $u * 12.0
  $g.DrawEllipse($pen, [float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
  $g.DrawLine($pen, [float]($cx + $r - $u * 0.2), [float]$cy, [float]($u * 19.6), [float]$cy)
  $g.DrawLine($pen, [float]($u * 15.9), [float]$cy, [float]($u * 15.9), [float]($cy + $u * 3.6))
  $g.DrawLine($pen, [float]($u * 19.0), [float]$cy, [float]($u * 19.0), [float]($cy + $u * 2.5))

  $pen.Dispose(); $brush.Dispose(); $bgPath.Dispose(); $g.Dispose()
  return $bmp
}

$densities = @{
  'mipmap-mdpi'    = 48
  'mipmap-hdpi'    = 72
  'mipmap-xhdpi'   = 96
  'mipmap-xxhdpi'  = 144
  'mipmap-xxxhdpi' = 192
}

foreach ($name in $densities.Keys) {
  $dir = Join-Path $resDir $name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $size = $densities[$name]

  $square = New-IconBitmap $size $false
  $square.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $square.Dispose()

  $round = New-IconBitmap $size $true
  $round.Save((Join-Path $dir 'ic_launcher_round.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $round.Dispose()

  Write-Output ("Wrote {0} icons at {1}x{1}" -f $name, $size)
}
