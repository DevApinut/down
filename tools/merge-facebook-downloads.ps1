param(
  [string]$Folder = "$env:USERPROFILE\Downloads",
  [switch]$DeleteParts
)

$ErrorActionPreference = "Stop"

function Find-Ffmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $local = Join-Path $PSScriptRoot "..\vendor\ffmpeg.exe"
  if (Test-Path -LiteralPath $local) { return (Resolve-Path -LiteralPath $local).Path }

  throw "ffmpeg.exe was not found. Install FFmpeg or put ffmpeg.exe at vendor\ffmpeg.exe"
}

function Get-OutputName([string]$VideoPath) {
  $name = [IO.Path]::GetFileNameWithoutExtension($VideoPath)
  $base = $name -replace "\s*\[video\]$", ""
  return Join-Path ([IO.Path]::GetDirectoryName($VideoPath)) ($base + ".mp4")
}

if (!(Test-Path -LiteralPath $Folder)) {
  throw "Folder was not found: $Folder"
}

$ffmpeg = Find-Ffmpeg
$videoFiles = Get-ChildItem -LiteralPath $Folder -Filter "* [video].mp4" -File

if (!$videoFiles) {
  Write-Host "No * [video].mp4 files found in $Folder"
  exit 0
}

$merged = 0
foreach ($video in $videoFiles) {
  $base = $video.BaseName -replace "\s*\[video\]$", ""
  $audio = Join-Path $video.DirectoryName ($base + " [audio].m4a")
  if (!(Test-Path -LiteralPath $audio)) {
    Write-Host "Skip: $($video.Name) because the matching audio file is missing"
    continue
  }

  $output = Get-OutputName $video.FullName
  if (Test-Path -LiteralPath $output) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $output = Join-Path $video.DirectoryName ($base + " merged-$stamp.mp4")
  }

  Write-Host "Merging: $base"
  & $ffmpeg -hide_banner -loglevel error -y -i $video.FullName -i $audio -c copy -movflags +faststart $output

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Merge failed: $base"
    continue
  }

  $merged++
  Write-Host "Done: $output"

  if ($DeleteParts) {
    Remove-Item -LiteralPath $video.FullName
    Remove-Item -LiteralPath $audio
  }
}

Write-Host "Merged $merged item(s)"
