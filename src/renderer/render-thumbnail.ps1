param(
  [Parameter(Mandatory = $true)][string]$InputPng,
  [Parameter(Mandatory = $true)][string]$OutputPng,
  [int]$Width = 320,
  [int]$Height = 420
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($InputPng)
try {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $sourceW = [Math]::Max(1, $image.Width)
    $targetAspect = [double]$Width / [double]$Height
    $sourceH = [Math]::Min($image.Height, [int][Math]::Round([double]$sourceW / $targetAspect))
    $sourceH = [Math]::Max(1, $sourceH)
    $sourceRect = [System.Drawing.Rectangle]::new(0, 0, $sourceW, $sourceH)
    $targetRect = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
    $graphics.DrawImage($image, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
    $bitmap.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
} finally {
  $image.Dispose()
}
