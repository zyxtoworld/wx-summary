param(
  [Parameter(Mandatory = $true)][string]$InputJson,
  [Parameter(Mandatory = $true)][string]$OutputPng
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function HtmlDecode([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  return [System.Net.WebUtility]::HtmlDecode($Text)
}

function FirstCodePoint([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return 0 }
  if ([char]::IsHighSurrogate($Text[0]) -and $Text.Length -gt 1) {
    return [char]::ConvertToUtf32($Text[0], $Text[1])
  }
  return [int][char]$Text[0]
}

function SuperscriptFallback([int]$CodePoint) {
  switch ($CodePoint) {
    0x2070 { return '0' }
    0x00B9 { return '1' }
    0x00B2 { return '2' }
    0x00B3 { return '3' }
    0x2074 { return '4' }
    0x2075 { return '5' }
    0x2076 { return '6' }
    0x2077 { return '7' }
    0x2078 { return '8' }
    0x2079 { return '9' }
    0x1D2C { return 'A' }
    0x1D2E { return 'B' }
    0x1D30 { return 'D' }
    0x1D31 { return 'E' }
    0x1D33 { return 'G' }
    0x1D34 { return 'H' }
    0x1D35 { return 'I' }
    0x1D36 { return 'J' }
    0x1D37 { return 'K' }
    0x1D38 { return 'L' }
    0x1D39 { return 'M' }
    0x1D3A { return 'N' }
    0x1D3C { return 'O' }
    0x1D3E { return 'P' }
    0x1D3F { return 'R' }
    0x1D40 { return 'T' }
    0x1D41 { return 'U' }
    0x2C7D { return 'V' }
    0x1D42 { return 'W' }
    default { return $null }
  }
}

function NormalizeDecorativeGlyph([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $normalized = $Text.Normalize([System.Text.NormalizationForm]::FormKC)
  if ($normalized -ne $Text -and $normalized -match '^[A-Za-z0-9 ()+./_-]+$') {
    return $normalized
  }
  return $Text
}

function IsHangingPunctuation([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $false }
  $codePoint = FirstCodePoint $Text
  return @(0x3001, 0xFF0C, 0x3002, 0xFF1B, 0xFF1A, 0xFF1F, 0xFF01, 0xFF09, 0x300B, 0x3011, 0x300D, 0x300F, 0x2C, 0x2E, 0x3B, 0x3A, 0x3F, 0x21, 0x29, 0x5D) -contains $codePoint
}

function RenderSafeText([string]$Text) {
  $value = HtmlDecode($Text)
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  $builder = [System.Text.StringBuilder]::new()
  $enum = [System.Globalization.StringInfo]::GetTextElementEnumerator($value)
  while ($enum.MoveNext()) {
    $element = [string]$enum.GetTextElement()
    $codePoint = FirstCodePoint $element
    if ($element.Length -ge 2 -and $element[$element.Length - 1] -eq [char]0x20E3 -and '0123456789#*'.Contains([string]$element[0])) {
      [void]$builder.Append([string]$element[0])
      continue
    }
    $decorative = NormalizeDecorativeGlyph $element
    if ($decorative -ne $element) {
      [void]$builder.Append($decorative)
      continue
    }
    if ($codePoint -ge 0x1F1E6 -and $codePoint -le 0x1F1FF) {
      [void]$builder.Append([char](65 + ($codePoint - 0x1F1E6)))
      continue
    }
    if ($codePoint -eq 0xFE0F -or $codePoint -eq 0x1BE4) { continue }
    if ($codePoint -ge 0x10400 -and $codePoint -le 0x1044F) {
      [void]$builder.Append('?')
      continue
    }
    $fallback = SuperscriptFallback $codePoint
    if ($null -ne $fallback) {
      [void]$builder.Append($fallback)
    } else {
      [void]$builder.Append($element)
    }
  }
  return $builder.ToString()
}

function NormalizeRenderedText([string]$Text) {
  $value = RenderSafeText($Text)
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  # Collapse spaced flag-letter nicknames after regional indicators are mapped to ASCII letters.
  return [regex]::Replace($value, '(?<![A-Za-z])(?:[A-Z]\s+){2,}[A-Z](?![A-Za-z])', { param($m) $m.Value -replace '\s+', '' })
}

function GetTextElements([string]$Text) {
  $items = [System.Collections.Generic.List[string]]::new()
  if ([string]::IsNullOrEmpty($Text)) { return $items }
  $enum = [System.Globalization.StringInfo]::GetTextElementEnumerator($Text)
  while ($enum.MoveNext()) {
    [void]$items.Add([string]$enum.GetTextElement())
  }
  return $items
}

$script:fontFallbackCache = @{}

function FontVariant($BaseFont, [string]$FamilyName) {
  $key = "$FamilyName|$($BaseFont.SizeInPoints)|$([int]$BaseFont.Style)"
  if (-not $script:fontFallbackCache.ContainsKey($key)) {
    $script:fontFallbackCache[$key] = [System.Drawing.Font]::new($FamilyName, $BaseFont.SizeInPoints, $BaseFont.Style)
  }
  return $script:fontFallbackCache[$key]
}

function ResolveGlyphFont($BaseFont, [string]$Element) {
  $codePoint = FirstCodePoint $Element
  if (($codePoint -ge 0x20000 -and $codePoint -le 0x2EBEF)) {
    return FontVariant $BaseFont 'SimSun-ExtB'
  }
  if (($codePoint -ge 0x30000 -and $codePoint -le 0x323AF)) {
    return FontVariant $BaseFont 'SimSun-ExtG'
  }
  if (($codePoint -ge 0x1F000 -and $codePoint -le 0x1FAFF) -or ($codePoint -ge 0x2600 -and $codePoint -le 0x27BF)) {
    return FontVariant $BaseFont 'Segoe UI Emoji'
  }
  if ($codePoint -gt 0xFFFF) {
    return FontVariant $BaseFont 'Segoe UI Historic'
  }
  return $BaseFont
}

function SplitAsciiWordOverflow([string]$Line, [string]$Ch) {
  if ([string]::IsNullOrEmpty($Line) -or $Ch -notmatch '^[A-Za-z0-9]$') { return $null }
  $match = [regex]::Match($Line, '([A-Za-z0-9][A-Za-z0-9_+./-]*)$')
  if (-not $match.Success -or $match.Index -le 0) { return $null }
  $head = $Line.Substring(0, $match.Index).TrimEnd()
  if ([string]::IsNullOrWhiteSpace($head)) { return $null }
  return [pscustomobject]@{ Head = $head; Tail = $match.Value + $Ch }
}

function GetTextRuns([string]$Text, $BaseFont) {
  $runs = [System.Collections.Generic.List[object]]::new()
  $runText = ''
  $runFont = $null
  foreach ($element in (GetTextElements $Text)) {
    $font = ResolveGlyphFont $BaseFont $element
    if ($null -ne $runFont -and $font.Name -eq $runFont.Name) {
      $runText += $element
    } else {
      if ($runText.Length -gt 0) {
        [void]$runs.Add([pscustomobject]@{ Text = $runText; Font = $runFont })
      }
      $runText = $element
      $runFont = $font
    }
  }
  if ($runText.Length -gt 0) {
    [void]$runs.Add([pscustomobject]@{ Text = $runText; Font = $runFont })
  }
  return $runs
}

function MeasureInlineText($Graphics, [string]$Text, $BaseFont) {
  $width = 0.0
  foreach ($run in (GetTextRuns $Text $BaseFont)) {
    $width += $Graphics.MeasureString([string]$run.Text, $run.Font).Width
  }
  return $width
}

function DrawInlineText($Graphics, [string]$Text, $BaseFont, $Brush, [float]$X, [float]$Y) {
  $cursor = $X
  foreach ($run in (GetTextRuns $Text $BaseFont)) {
    $Graphics.DrawString([string]$run.Text, $run.Font, $Brush, $cursor, $Y)
    $cursor += $Graphics.MeasureString([string]$run.Text, $run.Font).Width
  }
}

function DrawWrappedText($Graphics, [string]$Text, $Font, $Brush, [float]$X, [float]$Y, [float]$MaxWidth, [float]$LineHeight) {
  $value = NormalizeRenderedText($Text)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Y }
  foreach ($paragraph in ($value -split "`n")) {
    $line = ''
    foreach ($ch in (GetTextElements $paragraph)) {
      $test = $line + $ch
      if ($Graphics.MeasureString($test, $Font).Width -gt $MaxWidth -and $line.Length -gt 0) {
        if (IsHangingPunctuation ([string]$ch)) {
          DrawInlineText $Graphics $test $Font $Brush $X $Y
          $Y += $LineHeight
          $line = ''
        } else {
          $wordSplit = SplitAsciiWordOverflow $line ([string]$ch)
          if ($null -ne $wordSplit) {
            DrawInlineText $Graphics ([string]$wordSplit.Head) $Font $Brush $X $Y
            $Y += $LineHeight
            $line = [string]$wordSplit.Tail
          } else {
            DrawInlineText $Graphics $line $Font $Brush $X $Y
            $Y += $LineHeight
            $line = [string]$ch
          }
        }
      } else {
        $line = $test
      }
    }
    if ($line.Length -gt 0) {
      DrawInlineText $Graphics $line $Font $Brush $X $Y
      $Y += $LineHeight
    }
  }
  return $Y
}

function NewRoundedRectPath([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function DrawCard($Graphics, [float]$X, [float]$Y, [float]$W, [float]$H, $FillBrush, $BorderPen) {
  $path = NewRoundedRectPath $X $Y $W $H 16
  $Graphics.FillPath($FillBrush, $path)
  $Graphics.DrawPath($BorderPen, $path)
  $path.Dispose()
}

function CountTextChars($Value) {
  if ($null -eq $Value) { return 0 }
  return ([string]$Value).Length
}

function Utf8Label([string]$Base64) {
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
}

$labelDigestTitle = Utf8Label 'd3gtc3VtbWFyeSDCtyDnvqTmtojmga/mgLvnu5M='
$labelMessages = Utf8Label '5p2h5raI5oGv'
$labelLocalData = Utf8Label '5pys5py65pWw5o2u'
$labelSelectedFrom = Utf8Label 'IMK3IOW3suS7jiA='
$labelSelectedMiddle = Utf8Label 'IOadoeS4reaIquWPliA='
$labelCountSuffix = Utf8Label 'IOadoQ=='
$labelHeadline = Utf8Label '5b+r6YCf57uT6K66'
$labelTodosPrefix = Utf8Label '6L+Y6KaB5aSE55CG77yI'
$labelRightParen = Utf8Label '77yJ'
$labelTopicsPrefix = Utf8Label '6YeN54K55LqL6aG577yI'
$labelParticipants = Utf8Label '55u45YWz5oiQ5ZGY77ya'
$labelListSep = Utf8Label '44CB'
$labelImportantLinks = Utf8Label '6ZO+5o6l6LWE5paZ'
$labelQuotes = Utf8Label '5Luj6KGo6K+05rOV'
$labelCoverage = Utf8Label '5pys5qyh6KaG55uW'
$labelTimeRow = Utf8Label '5pe26Ze077ya'
$labelMessageRow = Utf8Label '5raI5oGv77ya'
$labelContentRow = Utf8Label '5YaF5a6577ya'
$labelSourceRow = Utf8Label '5p2l5rqQ77ya'
$labelTopicCount = Utf8Label '5Liq6YeN54K55LqL6aG577yM'
$labelLinkCount = Utf8Label '5Liq572R6aG16ZO+5o6l77yM'
$labelTodoCount = Utf8Label '5Liq6ZyA5aSE55CG5LqL6aG577yM'
$labelQuoteCount = Utf8Label '5p2h5Luj6KGo6K+05rOV'
$labelMetaSep = Utf8Label 'IMK3IA=='
$labelSender = Utf8Label '5Y+R6YCB5Lq677ya'
$labelTime = Utf8Label '5pe26Ze077ya'
$labelCreatedAt = Utf8Label '55Sf5oiQ5LqOIA=='
$labelModel = Utf8Label 'ICAgIOaooeWei++8mg=='
$labelLocalProcessing = Utf8Label 'ICAgIOacrOWcsOivu+WPliDCtyBBSSDmsYfmgLs='
$labelTooLongPrefix = Utf8Label '5pGY6KaB5YaF5a656L+H6ZW/77yM5pyN5Yqh56uvIFBORyDpq5jluqbkvLDnrpfkuI3otrPvvJvpnIDopoEg'
$labelTooLongMiddle = Utf8Label 'IHB477yM5b2T5YmN5bel5L2c55S75biDIA=='
$labelTooLongSuffix = Utf8Label 'IHB444CC'

$digest = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$render = $digest.__render
$renderTheme = if ($render -and $render.theme -eq 'dark') { 'dark' } else { 'light' }
$script:renderScale = if ($render -and $render.font_size -eq 'large') { 1.14 } else { 1.0 }
function S([float]$Value) {
  return [int][Math]::Round($Value * $script:renderScale)
}
function IsHexColor([string]$Value) {
  return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -match '^#[0-9A-Fa-f]{6}$'
}
$renderAccent = if ($render -and (IsHexColor ([string]$render.accent_color))) { [string]$render.accent_color } else { '' }
$width = 2160
$padding = 32
$cardWidth = $width - $padding * 2

$highlightItems = @()
if ($digest.highlights) {
  foreach ($item in $digest.highlights) {
    $textValue = ([string]$item).Trim()
    if ($textValue -and $textValue -ne ([string]$digest.headline) -and -not $highlightItems.Contains($textValue)) {
      $highlightItems += $textValue
      if ($highlightItems.Count -ge 5) { break }
    }
  }
}
$quoteItems = @()
if ($digest.quotes) {
  foreach ($quote in $digest.quotes) {
    $quoteText = ''
    if ($quote -is [string]) { $quoteText = [string]$quote } else { $quoteText = [string]$quote.text }
    if ($quoteText.Trim()) {
      $quoteItems += $quote
      if ($quoteItems.Count -ge 6) { break }
    }
  }
}
$topicTotal = if ($digest.topics) { $digest.topics.Count } else { 0 }
$linkTotal = if ($digest.links) { $digest.links.Count } else { 0 }
$todoTotal = if ($digest.todos) { $digest.todos.Count } else { 0 }
$quoteTotal = $quoteItems.Count

$contentChars = 0
$contentChars += CountTextChars $digest.group
$contentChars += CountTextChars $digest.headline
$contentChars += CountTextChars $digest.source_label
$contentChars += CountTextChars ($highlightItems -join ' ')
$rowCount = 8
if ($digest.todos) {
  foreach ($todo in $digest.todos) {
    $contentChars += CountTextChars $todo.item
    $contentChars += CountTextChars $todo.owner
    $contentChars += CountTextChars $todo.deadline
    $rowCount += 2
  }
}
if ($digest.topics) {
  foreach ($topic in $digest.topics) {
    $contentChars += CountTextChars $topic.title
    $contentChars += CountTextChars $topic.summary
    if ($topic.participants) { $contentChars += CountTextChars (($topic.participants | Select-Object -First 12) -join $labelListSep) }
    $rowCount += 4
  }
}
if ($digest.links) {
  foreach ($link in $digest.links) {
    $contentChars += CountTextChars $link.title
    $contentChars += CountTextChars $link.summary
    $contentChars += CountTextChars $link.url
    $contentChars += CountTextChars $link.from
    $contentChars += CountTextChars $link.time
    $rowCount += 3
  }
}
foreach ($quote in $quoteItems) {
  if ($quote -is [string]) {
    $contentChars += CountTextChars $quote
  } else {
    $contentChars += CountTextChars $quote.text
    $contentChars += CountTextChars $quote.speaker
    $contentChars += CountTextChars $quote.context
  }
  $rowCount += 2
}
$estimatedLines = [Math]::Ceiling([double]([Math]::Max(1, $contentChars)) / 34)
$estimatedHeight = [int](1400 + $estimatedLines * 104 + $rowCount * 148)
$maxWorkHeight = 60000
$workHeight = [Math]::Min($maxWorkHeight, [Math]::Max(26000, $estimatedHeight))

$bitmap = [System.Drawing.Bitmap]::new($width, $workHeight)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

if ($renderTheme -eq 'dark') {
  $bg = [System.Drawing.ColorTranslator]::FromHtml('#0E0E10')
  $card = [System.Drawing.ColorTranslator]::FromHtml('#1A1A1D')
  $border = [System.Drawing.ColorTranslator]::FromHtml('#2A2A2E')
  $separator = [System.Drawing.ColorTranslator]::FromHtml('#34343A')
  $text = [System.Drawing.ColorTranslator]::FromHtml('#EDEDED')
  $muted = [System.Drawing.ColorTranslator]::FromHtml('#9CA3AF')
  $meta = [System.Drawing.ColorTranslator]::FromHtml('#D1D5DB')
  $primary = [System.Drawing.ColorTranslator]::FromHtml('#34D399')
} else {
  $bg = [System.Drawing.ColorTranslator]::FromHtml('#FAFAFA')
  $card = [System.Drawing.Color]::White
  $border = [System.Drawing.ColorTranslator]::FromHtml('#E5E5E5')
  $separator = [System.Drawing.ColorTranslator]::FromHtml('#E5E7EB')
  $text = [System.Drawing.ColorTranslator]::FromHtml('#111111')
  $muted = [System.Drawing.ColorTranslator]::FromHtml('#4B5563')
  $meta = [System.Drawing.ColorTranslator]::FromHtml('#374151')
  $primary = [System.Drawing.ColorTranslator]::FromHtml('#10B981')
}
if ($renderAccent) {
  $primary = [System.Drawing.ColorTranslator]::FromHtml($renderAccent)
}

$graphics.Clear($bg)
$fontMeta = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 26), [System.Drawing.FontStyle]::Regular)
$fontSmall = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 28), [System.Drawing.FontStyle]::Regular)
$fontParticipant = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 28), [System.Drawing.FontStyle]::Regular)
$fontBody = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 34), [System.Drawing.FontStyle]::Regular)
$fontBodyBold = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 34), [System.Drawing.FontStyle]::Bold)
$fontH2 = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 40), [System.Drawing.FontStyle]::Bold)
$fontTitle = [System.Drawing.Font]::new('Microsoft YaHei UI', (S 52), [System.Drawing.FontStyle]::Bold)

$brushText = [System.Drawing.SolidBrush]::new($text)
$brushMuted = [System.Drawing.SolidBrush]::new($muted)
$brushMeta = [System.Drawing.SolidBrush]::new($meta)
$brushPrimary = [System.Drawing.SolidBrush]::new($primary)
$brushCard = [System.Drawing.SolidBrush]::new($card)
$penBorder = [System.Drawing.Pen]::new($border, 2)
$penSeparator = [System.Drawing.Pen]::new($separator, 2)

$y = $padding
$graphics.DrawString($labelDigestTitle, $fontMeta, $brushMuted, $padding, $y); $y += (S 52)
$y = DrawWrappedText $graphics ([string]$digest.group) $fontTitle $brushText $padding $y ($cardWidth) (S 88)
$y += (S 28)
$sourceText = ''
if ($digest.source_label -or $digest.truncated) {
  $source = if ($digest.source_label) { [string]$digest.source_label } else { $labelLocalData }
  if ($digest.truncated) {
    $source += "$labelSelectedFrom$($digest.scanned_message_count)$labelSelectedMiddle$($digest.input_message_count)$labelCountSuffix"
  }
  $sourceText = "    $source"
}
$meta = "$($digest.since) ~ $($digest.until)    $($digest.message_count) $labelMessages    $($digest.model)$sourceText"
$y = DrawWrappedText $graphics $meta $fontSmall $brushMuted $padding $y ($cardWidth) (S 48)
$y += (S 20)

$cardY = $y
$innerY = $cardY + (S 20)
$innerY += (S 50)
$innerY = DrawWrappedText $graphics ([string]$digest.headline) $fontTitle $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 84)
if ($highlightItems.Count -gt 0) {
  $innerY += (S 16)
  foreach ($item in $highlightItems) {
    $innerY = DrawWrappedText $graphics ("- " + [string]$item) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    $innerY += (S 8)
  }
}
$cardH = $innerY - $cardY + (S 20)
DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
  $graphics.DrawString($labelHeadline, $fontSmall, $brushPrimary, $padding + 34, $cardY + (S 20))
$innerY = DrawWrappedText $graphics ([string]$digest.headline) $fontTitle $brushText ($padding + 34) ($cardY + (S 70)) ($cardWidth - 68) (S 84)
if ($highlightItems.Count -gt 0) {
  $innerY += (S 16)
  foreach ($item in $highlightItems) {
    $innerY = DrawWrappedText $graphics ("- " + [string]$item) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    $innerY += (S 8)
  }
}
$y = $cardY + $cardH + (S 12)

if ($digest.todos -and $digest.todos.Count -gt 0) {
  $cardY = $y
  $innerY = $cardY + (S 20)
  $innerY += (S 68)
  foreach ($todo in $digest.todos) {
    $innerY = DrawWrappedText $graphics ("- " + [string]$todo.item) $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 68)
    $todoMeta = @($todo.owner, $todo.deadline) | Where-Object { $_ } 
    if ($todoMeta.Count -gt 0) { $innerY = DrawWrappedText $graphics ($todoMeta -join ' / ') $fontSmall $brushMuted ($padding + 62) $innerY ($cardWidth - 96) (S 48) }
    $innerY += (S 20)
  }
  $cardH = $innerY - $cardY + (S 10)
  DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
  $innerY = $cardY + (S 20)
  $graphics.DrawString("$labelTodosPrefix$($digest.todos.Count)$labelRightParen", $fontH2, $brushPrimary, $padding + 34, $innerY); $innerY += (S 68)
  foreach ($todo in $digest.todos) {
    $innerY = DrawWrappedText $graphics ("- " + [string]$todo.item) $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 68)
    $todoMeta = @($todo.owner, $todo.deadline) | Where-Object { $_ }
    if ($todoMeta.Count -gt 0) { $innerY = DrawWrappedText $graphics ($todoMeta -join ' / ') $fontSmall $brushMuted ($padding + 62) $innerY ($cardWidth - 96) (S 48) }
    $innerY += (S 20)
  }
  $y = $cardY + $cardH + (S 12)
}

if ($digest.topics -and $digest.topics.Count -gt 0) {
  $cardY = $y
  $innerY = $cardY + (S 20)
  $innerY += (S 72)
  $topicTitleLineHeight = S 68
  $topicTitleGap = S 20
  $topicNoParticipantGap = S 24
  $participantLineHeight = S 48
  $participantSummaryGap = S 32
  $summaryLineHeight = S 62
  $topicAfterSummaryGap = S 28
  $topicSeparatorGap = S 36
  $topicCount = $digest.topics.Count
  $i = 1
  foreach ($topic in $digest.topics) {
    $innerY = DrawWrappedText $graphics ("$i. " + [string]$topic.title) $fontH2 $brushText ($padding + 34) $innerY ($cardWidth - 68) $topicTitleLineHeight
    if ($topic.participants -and $topic.participants.Count -gt 0) {
      $innerY += $topicTitleGap
      $participantTop = $innerY
      $innerY = DrawWrappedText $graphics ($labelParticipants + (($topic.participants | Select-Object -First 12) -join $labelListSep)) $fontParticipant $brushMeta ($padding + 62) $innerY ($cardWidth - 124) $participantLineHeight
      $participantHeight = [Math]::Max((S 36), $innerY - $participantTop - (S 8))
      $graphics.FillRectangle($brushPrimary, $padding + 42, $participantTop + (S 8), 6, $participantHeight)
      $innerY += $participantSummaryGap
    } else {
      $innerY += $topicNoParticipantGap
    }
    $innerY = DrawWrappedText $graphics ([string]$topic.summary) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) $summaryLineHeight
    if ($i -lt $topicCount) {
      $innerY += $topicAfterSummaryGap
      $graphics.DrawLine($penSeparator, $padding + 34, $innerY, $padding + $cardWidth - 34, $innerY)
      $innerY += $topicSeparatorGap
    } else {
      $innerY += (S 12)
    }
    $i++
  }
  $cardH = $innerY - $cardY + (S 12)
  DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
  $innerY = $cardY + (S 20)
  $graphics.DrawString("$labelTopicsPrefix$($digest.topics.Count)$labelRightParen", $fontH2, $brushPrimary, $padding + 34, $innerY); $innerY += (S 72)
  $i = 1
  foreach ($topic in $digest.topics) {
    $innerY = DrawWrappedText $graphics ("$i. " + [string]$topic.title) $fontH2 $brushText ($padding + 34) $innerY ($cardWidth - 68) $topicTitleLineHeight
    if ($topic.participants -and $topic.participants.Count -gt 0) {
      $innerY += $topicTitleGap
      $participantTop = $innerY
      $innerY = DrawWrappedText $graphics ($labelParticipants + (($topic.participants | Select-Object -First 12) -join $labelListSep)) $fontParticipant $brushMeta ($padding + 62) $innerY ($cardWidth - 124) $participantLineHeight
      $participantHeight = [Math]::Max((S 36), $innerY - $participantTop - (S 8))
      $graphics.FillRectangle($brushPrimary, $padding + 42, $participantTop + (S 8), 6, $participantHeight)
      $innerY += $participantSummaryGap
    } else {
      $innerY += $topicNoParticipantGap
    }
    $innerY = DrawWrappedText $graphics ([string]$topic.summary) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) $summaryLineHeight
    if ($i -lt $topicCount) {
      $innerY += $topicAfterSummaryGap
      $graphics.DrawLine($penSeparator, $padding + 34, $innerY, $padding + $cardWidth - 34, $innerY)
      $innerY += $topicSeparatorGap
    } else {
      $innerY += (S 12)
    }
    $i++
  }
  $y = $cardY + $cardH + (S 12)
}

if ($digest.links -and $digest.links.Count -gt 0) {
  $cardY = $y
  $innerY = $cardY + (S 20)
  $innerY += (S 72)
  $linkIndex = 0
  $linkCount = $digest.links.Count
  foreach ($link in $digest.links) {
    if ($linkIndex -gt 0) {
      $innerY += (S 20)
      $graphics.DrawLine($penSeparator, $padding + 62, $innerY, $padding + $cardWidth - 62, $innerY)
      $innerY += (S 32)
    }
    $title = if ($link.title) { [string]$link.title } elseif ($link.summary) { [string]$link.summary } else { [string]$link.url }
    $innerY = DrawWrappedText $graphics ("- " + $title) $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    $innerY += (S 12)
    if ($link.summary) {
      $innerY = DrawWrappedText $graphics ([string]$link.summary) $fontBody $brushText ($padding + 62) $innerY ($cardWidth - 96) (S 62)
    }
    if ($link.url) { $innerY = DrawWrappedText $graphics ([string]$link.url) $fontMeta $brushMeta ($padding + 62) $innerY ($cardWidth - 96) (S 44) }
    $by = @(
      if ($link.from) { "$labelSender$($link.from)" }
      if ($link.time) { "$labelTime$($link.time)" }
    ) | Where-Object { $_ }
    if ($by.Count -gt 0) { $innerY = DrawWrappedText $graphics ($by -join $labelMetaSep) $fontMeta $brushMeta ($padding + 62) $innerY ($cardWidth - 96) (S 44) }
    if ($linkIndex -lt ($linkCount - 1)) { $innerY += (S 20) } else { $innerY += (S 16) }
    $linkIndex++
  }
  $cardH = $innerY - $cardY + (S 12)
  DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
  $innerY = $cardY + (S 20)
  $graphics.DrawString($labelImportantLinks, $fontH2, $brushPrimary, $padding + 34, $innerY); $innerY += (S 72)
  $linkIndex = 0
  $linkCount = $digest.links.Count
  foreach ($link in $digest.links) {
    if ($linkIndex -gt 0) {
      $innerY += (S 20)
      $graphics.DrawLine($penSeparator, $padding + 62, $innerY, $padding + $cardWidth - 62, $innerY)
      $innerY += (S 32)
    }
    $title = if ($link.title) { [string]$link.title } elseif ($link.summary) { [string]$link.summary } else { [string]$link.url }
    $innerY = DrawWrappedText $graphics ("- " + $title) $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    $innerY += (S 12)
    if ($link.summary) {
      $innerY = DrawWrappedText $graphics ([string]$link.summary) $fontBody $brushText ($padding + 62) $innerY ($cardWidth - 96) (S 62)
    }
    if ($link.url) { $innerY = DrawWrappedText $graphics ([string]$link.url) $fontMeta $brushMeta ($padding + 62) $innerY ($cardWidth - 96) (S 44) }
    $by = @(
      if ($link.from) { "$labelSender$($link.from)" }
      if ($link.time) { "$labelTime$($link.time)" }
    ) | Where-Object { $_ }
    if ($by.Count -gt 0) { $innerY = DrawWrappedText $graphics ($by -join $labelMetaSep) $fontMeta $brushMeta ($padding + 62) $innerY ($cardWidth - 96) (S 44) }
    if ($linkIndex -lt ($linkCount - 1)) { $innerY += (S 20) } else { $innerY += (S 16) }
    $linkIndex++
  }
  $y = $cardY + $cardH + (S 12)
}

if ($quoteItems.Count -gt 0) {
  $cardY = $y
  $innerY = $cardY + (S 20)
  $innerY += (S 72)
  $quoteIndex = 0
  foreach ($quote in $quoteItems) {
    $quoteText = ''
    $quoteMeta = @()
    if ($quote -is [string]) {
      $quoteText = [string]$quote
    } else {
      $quoteText = [string]$quote.text
      if ($quote.speaker) { $quoteMeta += [string]$quote.speaker }
      if ($quote.context) { $quoteMeta += [string]$quote.context }
    }
    $innerY = DrawWrappedText $graphics ("`"" + $quoteText + "`"") $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    if ($quoteMeta.Count -gt 0) {
      $innerY = DrawWrappedText $graphics ($quoteMeta -join $labelMetaSep) $fontSmall $brushMuted ($padding + 62) $innerY ($cardWidth - 96) (S 48)
    }
    if ($quoteIndex -lt ($quoteItems.Count - 1)) { $innerY += (S 24) } else { $innerY += (S 12) }
    $quoteIndex++
  }
  $cardH = $innerY - $cardY + (S 12)
  DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
  $innerY = $cardY + (S 20)
  $graphics.DrawString($labelQuotes, $fontH2, $brushPrimary, $padding + 34, $innerY); $innerY += (S 72)
  $quoteIndex = 0
  foreach ($quote in $quoteItems) {
    $quoteText = ''
    $quoteMeta = @()
    if ($quote -is [string]) {
      $quoteText = [string]$quote
    } else {
      $quoteText = [string]$quote.text
      if ($quote.speaker) { $quoteMeta += [string]$quote.speaker }
      if ($quote.context) { $quoteMeta += [string]$quote.context }
    }
    $innerY = DrawWrappedText $graphics ("`"" + $quoteText + "`"") $fontBodyBold $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 62)
    if ($quoteMeta.Count -gt 0) {
      $innerY = DrawWrappedText $graphics ($quoteMeta -join $labelMetaSep) $fontSmall $brushMuted ($padding + 62) $innerY ($cardWidth - 96) (S 48)
    }
    if ($quoteIndex -lt ($quoteItems.Count - 1)) { $innerY += (S 24) } else { $innerY += (S 12) }
    $quoteIndex++
  }
  $y = $cardY + $cardH + (S 12)
}

$coverageSource = if ($digest.source_label) { [string]$digest.source_label } else { $labelLocalData }
$coverageRows = @(
  "$labelTimeRow$($digest.since) ~ $($digest.until)",
  "$labelMessageRow$($digest.message_count) $labelMessages",
  "$labelContentRow$topicTotal $labelTopicCount$linkTotal $labelLinkCount$todoTotal $labelTodoCount$quoteTotal $labelQuoteCount",
  "$labelSourceRow$coverageSource    $labelModel$($digest.model)"
)
$cardY = $y
$innerY = $cardY + (S 20)
$innerY += (S 72)
foreach ($row in $coverageRows) {
  $innerY = DrawWrappedText $graphics ("- " + [string]$row) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 58)
  $innerY += (S 8)
}
$cardH = $innerY - $cardY + (S 12)
DrawCard $graphics $padding $cardY $cardWidth $cardH $brushCard $penBorder
$innerY = $cardY + (S 20)
$graphics.DrawString($labelCoverage, $fontH2, $brushPrimary, $padding + 34, $innerY); $innerY += (S 72)
foreach ($row in $coverageRows) {
  $innerY = DrawWrappedText $graphics ("- " + [string]$row) $fontBody $brushText ($padding + 34) $innerY ($cardWidth - 68) (S 58)
  $innerY += (S 8)
}
$y = $cardY + $cardH + (S 12)

$created = [DateTime]::Now
if ($digest.created_at) {
  try { $created = [DateTime]::Parse([string]$digest.created_at).ToLocalTime() } catch {}
}
$footer = "$labelCreatedAt$($created.ToString('yyyy-MM-dd HH:mm'))$labelModel$($digest.model)$labelLocalProcessing"
$y = DrawWrappedText $graphics $footer $fontMeta $brushMuted $padding $y ($cardWidth) (S 48)
$y += (S 12)

if ($y -gt $workHeight) {
  $graphics.Dispose()
  $bitmap.Dispose()
  throw "$labelTooLongPrefix$([int]$y)$labelTooLongMiddle$workHeight$labelTooLongSuffix"
}

$final = [System.Drawing.Bitmap]::new($width, [Math]::Max(1, [int]$y))
$finalGraphics = [System.Drawing.Graphics]::FromImage($final)
$targetRect = [System.Drawing.Rectangle]::new(0, 0, $width, [int]$y)
$sourceRect = [System.Drawing.Rectangle]::new(0, 0, $width, [int]$y)
$finalGraphics.DrawImage($bitmap, $targetRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)

$outDir = Split-Path -Parent $OutputPng
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$final.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)

$finalGraphics.Dispose()
$final.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
