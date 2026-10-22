param([string[]]$Names)
$ErrorActionPreference = 'Continue'
Set-Location "$PSScriptRoot\models"
$B = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
if (!(Test-Path silero_vad.onnx)) { curl.exe -sSL -o silero_vad.onnx "$B/silero_vad.onnx" }
foreach ($n in ($Names -join ',').Split(',')) {
  $n = $n.Trim(); if (!$n) { continue }
  if (Test-Path $n) { "have $n"; continue }
  curl.exe -sSL --retry 3 -o "$n.tar.bz2" "$B/$n.tar.bz2"
  tar -xjf "$n.tar.bz2"
  if (Test-Path $n) { Remove-Item "$n.tar.bz2"; "got $n" } else { "FAILED $n" }
}
