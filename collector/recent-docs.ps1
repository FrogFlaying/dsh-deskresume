#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only document index: which files has this user opened recently, and where
  are they now?

.DESCRIPTION
  DeskResume can infer that an application was showing N documents from the
  window titles in its own snapshot history (see lib/documents.js). Turning those
  file names into openable paths is the job of this script.

  Two sources, merged:

    1. The user's Recent shortcuts (%APPDATA%\Microsoft\Windows\Recent*.lnk).
       Every document opened through a file dialog or a double-click gets one,
       and the shortcut knows the target path. Covers any application.
    2. WPS Office's own recent list in the registry
       (HKCU\Software\Kingsoft\Office\6.0\<app>\RecentFiles\Sequence). Values are
       full paths with the timestamp they were last opened, which is both more
       direct and more complete than the shortcuts for WPS.

  Output is a JSON file, not stdout: PowerShell 5.1 writes the console in the OEM
  code page on this machine, and these paths are full of Chinese. The same
  encoding trap already broke window-title matching once (see README, pitfall #2).
  This file is deliberately pure ASCII for the same reason: a BOM-less .ps1 is
  read with the ANSI code page, so non-ASCII inside a script is a hazard.

  READ-ONLY: it never opens, moves or deletes anything. It only reads shortcuts
  and registry values, and calls Test-Path on candidates.

.PARAMETER Out
  Where to write the JSON index.

.PARAMETER MaxAgeDays
  Ignore documents last opened longer ago than this. A restore wants what was open
  this session, not the last three years.

.PARAMETER MaxPerSource
  Upper bound per source before the existence check, newest first. Keeps the run
  under a second on a machine with thousands of historical entries.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Out,
  [int] $MaxAgeDays = 90,
  [int] $MaxPerSource = 600
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cutoffMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ([int64]$MaxAgeDays * 86400000)
$entries = New-Object System.Collections.ArrayList
$accepted = @{}
$counts = [ordered]@{ considered = 0; missing = 0; kept = 0 }
$problems = New-Object System.Collections.ArrayList

$docExtensions = @(
  '.xlsx', '.xlsm', '.xls', '.docx', '.docm', '.doc', '.pptx', '.pptm', '.ppt',
  '.pdf', '.csv', '.txt', '.md', '.markdown', '.rtf', '.wps', '.et', '.dps',
  '.ofd', '.htm', '.html', '.json', '.xml', '.yml', '.yaml', '.log', '.sql'
)

function Get-BaseName([string] $p) {
  $i = [Math]::Max($p.LastIndexOf('\'), $p.LastIndexOf('/'))
  if ($i -ge 0) { return $p.Substring($i + 1) }
  return $p
}

function Add-Entry([string] $filePath, [int64] $modifiedMs, [string] $source) {
  if (-not $filePath) { return }
  $filePath = $filePath.Trim()
  if (-not $filePath) { return }
  # Only absolute local paths: a shortcut can point at a URL or a shell folder.
  # WPS records "D:/path/file.xlsx" with FORWARD slashes, so accept both forms
  # before normalising. Requiring a backslash here silently discarded every WPS
  # entry, which is the one source that carries full paths.
  if ($filePath -notmatch '^[a-zA-Z]:[\\/]' -and $filePath -notmatch '^\\\\') { return }
  $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
  if ($docExtensions -notcontains $ext) { return }
  if ($modifiedMs -lt $cutoffMs) { return }
  # Normalise to backslashes so two sources describing one file dedupe.
  $normalised = $filePath -replace '/', '\'
  [void]$entries.Add([pscustomobject]@{
    name       = Get-BaseName $normalised
    path       = $normalised
    modifiedMs = $modifiedMs
    source     = $source
  })
  # Count what was KEPT, per source. Counting attempts made the summary read
  # "1763 WPS entries" when 1700 of them were years old and correctly dropped.
  if ($accepted.ContainsKey($source)) { $accepted[$source]++ } else { $accepted[$source] = 1 }
}

# --- source 1: Recent shortcuts -------------------------------------------------
try {
  $recentDir = [Environment]::GetFolderPath('Recent')
  if ($recentDir -and (Test-Path -LiteralPath $recentDir)) {
    $shell = New-Object -ComObject WScript.Shell
    $links = Get-ChildItem -LiteralPath $recentDir -Filter '*.lnk' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First $MaxPerSource
    foreach ($link in $links) {
      try {
        $target = $shell.CreateShortcut($link.FullName).TargetPath
        if (-not $target) { continue }
        $ms = [DateTimeOffset]::new($link.LastWriteTime).ToUnixTimeMilliseconds()
        Add-Entry $target $ms 'recent'
      } catch { /* a broken shortcut is not a failure of the scan */ }
    }
  } else {
    [void]$problems.Add('Recent folder not found')
  }
} catch {
  [void]$problems.Add("Recent scan failed: $($_.Exception.Message)")
}

# --- source 2: WPS Office recent lists -------------------------------------------
# Names are full paths already; the value is the Unix time it was last opened.
foreach ($app in @('wps', 'et', 'wpp', 'pdf')) {
  $key = "HKCU:\Software\Kingsoft\Office\6.0\$app\RecentFiles\Sequence"
  if (-not (Test-Path -LiteralPath $key)) { continue }
  try {
    $props = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).PSObject.Properties |
             Where-Object { $_.Name -notlike 'PS*' }
    $candidates = foreach ($p in $props) {
      $stamp = 0L
      if (-not [int64]::TryParse([string]$p.Value, [ref]$stamp)) { continue }
      # Entries are epoch seconds; tolerate milliseconds just in case.
      if ($stamp -gt 100000000000) { continue }
      [pscustomobject]@{ path = [string]$p.Name; ms = $stamp * 1000 }
    }
    $candidates = $candidates | Sort-Object ms -Descending | Select-Object -First $MaxPerSource
    foreach ($c in $candidates) {
      Add-Entry $c.path $c.ms "wps-$app"
    }
  } catch {
    [void]$problems.Add("WPS registry scan ($app) failed: $($_.Exception.Message)")
  }
}

# --- existence check and dedupe --------------------------------------------------
$byPath = @{}
foreach ($e in $entries) { $counts.considered++ }
foreach ($e in $entries) {
  try {
    if (-not (Test-Path -LiteralPath $e.path -PathType Leaf)) { $counts.missing++; continue }
  } catch { $counts.missing++; continue }
  $key = $e.path.ToLowerInvariant()
  if (-not $byPath.ContainsKey($key) -or $byPath[$key].modifiedMs -lt $e.modifiedMs) {
    $byPath[$key] = $e
  }
}

$final = @($byPath.Values | Sort-Object modifiedMs -Descending)
$counts.considered = $entries.Count
$counts.kept = $final.Count

$result = [ordered]@{
  ok          = $true
  generatedAt = (Get-Date).ToString('o')
  sources     = [ordered]@{}
  counts      = $counts
  problems    = @($problems)
  entries     = $final
}
foreach ($k in ($accepted.Keys | Sort-Object)) { $result.sources[$k] = $accepted[$k] }

$json = $result | ConvertTo-Json -Depth 6
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Out, $json, $utf8)
exit 0
