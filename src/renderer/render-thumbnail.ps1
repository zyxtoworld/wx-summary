param(
  [Parameter(Mandatory = $true)][string]$InputPng,
  [Parameter(Mandatory = $true)][string]$OutputPng,
  [int]$Width = 320,
  [int]$Height = 420
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
$fileStream = [System.IO.File]::Open($InputPng, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
$memoryStream = [System.IO.MemoryStream]::new()
try {
  $fileStream.CopyTo($memoryStream)
} finally {
  $fileStream.Dispose()
}
$memoryStream.Position = 0
$image = [System.Drawing.Image]::FromStream($memoryStream, $false, $false)
try {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $sourceW = [Math]::Max(1, $image.Width)
    $sourceH = [Math]::Max(1, $image.Height)
    $scaledH = [Math]::Max(1, [int][Math]::Round([double]$sourceH * [double]$Width / [double]$sourceW))
    $sourceRect = [System.Drawing.Rectangle]::new(0, 0, $sourceW, $sourceH)
    $targetRect = [System.Drawing.Rectangle]::new(0, 0, $Width, $scaledH)
    $graphics.DrawImage($image, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    $bitmap.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
} finally {
  $image.Dispose()
  $memoryStream.Dispose()
}
