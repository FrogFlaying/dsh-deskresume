#Requires -Version 5.1
<#
.SYNOPSIS
  DeskResume unattended-capture uninstaller.

.DESCRIPTION
  Removes the scheduled tasks created by install-tasks.ps1.

  Deliberately does NOT delete snapshots in data/. Those are the user's recorded
  sessions, and uninstalling the automation is not a request to destroy them.

.PARAMETER TaskPath
  Task Scheduler folder. Default '\DeskResume\'.

.PARAMETER PurgeSnapshots
  Also delete every snapshot in data/. Off by default; requires an explicit flag
  because it is irreversible.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\uninstall-tasks.ps1
#>
[CmdletBinding()]
param(
  [string] $TaskPath = '\DeskResume\',
  [switch] $PurgeSnapshots
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $RootDir 'data'

$removed = 0
foreach ($name in @('DeskResume-Interval', 'DeskResume-SessionEnd')) {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "[deskresume] not installed: $TaskPath$name"
    continue
  }
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false
  Write-Host "[deskresume] removed: $TaskPath$name"
  $removed++
}

if ($removed -eq 0) {
  Write-Host '[deskresume] nothing to remove.'
} else {
  Write-Host "[deskresume] removed $removed task(s)."
}

if ($PurgeSnapshots) {
  if (Test-Path -LiteralPath $DataDir) {
    $files = Get-ChildItem -LiteralPath $DataDir -Filter 'snapshot-*.json' -ErrorAction SilentlyContinue
    foreach ($f in $files) { Remove-Item -LiteralPath $f.FullName -Force }
    Write-Host "[deskresume] purged $($files.Count) snapshot(s) from $DataDir"
  }
} else {
  Write-Host '[deskresume] snapshots in data\ were left untouched (use -PurgeSnapshots to delete them).'
}

exit 0
