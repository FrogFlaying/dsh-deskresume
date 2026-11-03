#Requires -Version 5.1
<#
.SYNOPSIS
  DeskResume unattended-capture installer.

.DESCRIPTION
  Registers the scheduled tasks that make DeskResume work without the user
  clicking anything: a periodic snapshot, and a snapshot at session end so the
  state immediately before a shutdown survives.

  SECURITY CONSTRAINT (deliberate, do not "improve" this later):
  every task invokes `collect.ps1` directly as a child process. No task starts an
  HTTP server, a listener, or any other network surface. A scheduled task runs
  outside DSH, so anything it exposed over HTTP would bypass the DSH web server's
  authentication entirely and be reachable by any local process. The collector is
  a pure-PowerShell, read-only script, so a direct invocation needs no network
  channel and has no authentication problem to solve.

  Also note the collector is invoked WITHOUT elevation. Elevating it would let it
  read more processes, but a scheduled task silently running elevated is a
  privilege change the user did not ask for; unreadable fields are reported as
  empty instead.

.PARAMETER IntervalSeconds
  How often to snapshot. Default 120 (from config/deskresume.json).

.PARAMETER Keep
  How many snapshots to retain. Default 30.

.PARAMETER TaskPath
  Task Scheduler folder. Default '\DeskResume\'.

.PARAMETER Uninstall
  Remove the tasks instead of creating them.

.PARAMETER DryRun
  Print what would be registered without touching Task Scheduler.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\install-tasks.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\install-tasks.ps1
#>
[CmdletBinding()]
param(
  [int] $IntervalSeconds = 0,
  [int] $Keep = 0,
  [string] $TaskPath = '\DeskResume\',
  [switch] $Uninstall,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$Collector = Join-Path $ScriptDir 'collect.ps1'
$ConfigDir = Join-Path $RootDir 'config'
$ConfigFile = Join-Path $ConfigDir 'deskresume.json'
$LocalConfigFile = Join-Path $ConfigDir 'deskresume.local.json'

if (-not (Test-Path -LiteralPath $Collector)) {
  throw "collector not found: $Collector"
}

# Defaults come from the same config files the plugin reads, so a user who
# changes the interval in one place does not get a scheduled task that disagrees
# with it. Resolution order mirrors lib/config.js: local overrides shipped.
#
# Read as UTF-8 explicitly. Windows PowerShell 5.1's Get-Content decodes a
# BOM-less file with the ANSI code page, which corrupts non-ASCII text (the
# shipped config contains Chinese) into invalid JSON. Same trap the collectors
# work around by passing files rather than stdio.
function Read-ConfigFile([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $raw = [System.IO.File]::ReadAllText($path, $utf8)
    return $raw | ConvertFrom-Json
  } catch {
    Write-Warning "could not read $path ($($_.Exception.Message)); ignoring it"
    return $null
  }
}

if ($IntervalSeconds -le 0) {
  $IntervalSeconds = 120
  $shippedCfg = Read-ConfigFile $ConfigFile
  $localCfg = Read-ConfigFile $LocalConfigFile

  foreach ($cfg in @($shippedCfg, $localCfg)) {
    if (-not $cfg) { continue }
    if ($cfg.intervalSeconds -and [int]$cfg.intervalSeconds -ge 15) {
      $IntervalSeconds = [int]$cfg.intervalSeconds
    }
    if ($cfg.keepSnapshots -and [int]$cfg.keepSnapshots -ge 1) {
      $Keep = [int]$cfg.keepSnapshots
    }
  }
}
if (-not $Keep -or $Keep -le 0) { $Keep = 30 }

$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShell)) { $PowerShell = 'powershell.exe' }

$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$HiddenLauncher = Join-Path $ScriptDir 'run-hidden.vbs'

$TaskInterval = 'DeskResume-Interval'
$TaskSessionEnd = 'DeskResume-SessionEnd'

# The task launches the collector through run-hidden.vbs rather than calling
# powershell.exe directly.
#
# Reason (measured, not assumed): a task that runs powershell.exe creates a
# conhost console window BEFORE PowerShell processes "-WindowStyle Hidden", so a
# console flashes on screen for roughly 100 ms at every capture interval. With
# the default 2-minute interval that is a visible interruption all day.
# WshShell.Run with window style 0 passes SW_HIDE in STARTUPINFO, so the console
# window is never shown at all.
#
# Measured on Windows 10 22H2 (see docs/capability-report.md):
#   direct powershell.exe  -> console window created, visible from ~101 ms
#   wscript + run-hidden.vbs -> console window created, never visible (0/93 polls)
#
# If wscript or the launcher is missing, fall back to the direct call so capture
# still works; a console flash is far better than no snapshot.
function Get-CollectorAction([string] $reason) {
  if ((Test-Path -LiteralPath $WScript) -and (Test-Path -LiteralPath $HiddenLauncher)) {
    return New-ScheduledTaskAction `
      -Execute $WScript `
      -Argument ('"{0}" {1} {2}' -f $HiddenLauncher, $reason, $Keep) `
      -WorkingDirectory $RootDir
  }

  Write-Warning 'run-hidden.vbs unavailable; falling back to a direct powershell.exe call (a console window may flash)'
  return New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Reason {1} -Keep {2}' -f $Collector, $reason, $Keep) `
    -WorkingDirectory $RootDir
}

# --- uninstall path ---------------------------------------------------------
if ($Uninstall) {
  foreach ($name in @($TaskInterval, $TaskSessionEnd)) {
    $existing = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
    if (-not $existing) {
      Write-Host "[deskresume] not installed: $TaskPath$name"
      continue
    }
    if ($DryRun) {
      Write-Host "[deskresume] DRY RUN would unregister: $TaskPath$name"
      continue
    }
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false
    Write-Host "[deskresume] unregistered: $TaskPath$name"
  }
  Write-Host '[deskresume] existing snapshots were left untouched.'
  exit 0
}

# --- install path -----------------------------------------------------------
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Session end: Event ID 1074 (a process initiated shutdown) and 6006 (clean
# shutdown) are logged by the system channel. A task triggered on those events
# runs the collector before the machine actually goes down, which is what makes
# the `session-end` reason (and therefore pickSnapshot's preference for it) real
# rather than aspirational.
#
# MSFT_TaskEventTrigger lives in the TaskScheduler CIM namespace. Looking it up
# without -Namespace silently returns nothing, which previously made this whole
# block a no-op that still printed a success message.
$sessionTriggers = @()
$triggerClass = Get-CimClass -ClassName MSFT_TaskEventTrigger `
  -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ErrorAction SilentlyContinue
if ($triggerClass) {
  foreach ($id in @(1074, 6006)) {
    $trigger = New-CimInstance -CimClass $triggerClass -ClientOnly
    $trigger.Enabled = $true
    $trigger.Subscription = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[EventID=$id]]</Select></Query></QueryList>"
    $sessionTriggers += $trigger
  }
} else {
  Write-Warning 'TaskScheduler CIM class unavailable; the pre-shutdown snapshot cannot be registered'
}

$intervalTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Seconds $IntervalSeconds)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# The collector reads other processes; it needs the interactive user's session,
# so it runs as the logged-on user rather than SYSTEM (which has no desktop).
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  $useHidden = (Test-Path -LiteralPath $WScript) -and (Test-Path -LiteralPath $HiddenLauncher)
  Write-Host '[deskresume] DRY RUN - nothing will be registered.'
  Write-Host ''
  Write-Host "  task path        : $TaskPath"
  Write-Host "  interval task    : $TaskInterval  every ${IntervalSeconds}s  reason=interval  keep=$Keep"
  Write-Host "  session-end task : $TaskSessionEnd  on System event 1074/6006  reason=session-end"
  Write-Host "  run as           : $currentUser (Limited, interactive)"
  if ($useHidden) {
    Write-Host "  action           : $WScript `"$HiddenLauncher`" <reason> $Keep"
    Write-Host '  console window   : none (hidden via WshShell.Run window style 0)'
  } else {
    Write-Host "  action           : $PowerShell -File `"$Collector`" ..."
    Write-Host '  console window   : WARNING launcher missing - a console may flash'
  }
  Write-Host "  network surface  : none (no HTTP listener is created)"
  exit 0
}

# Register-ScheduledTask creates a missing task folder itself. An earlier
# attempt used `New-Item -Path Task:\...`, which fails because this host has no
# Task: PSDrive, and the failure then silently downgraded the task path to the
# root folder.
$registered = @()

Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskInterval `
  -Action (Get-CollectorAction 'interval') `
  -Trigger $intervalTrigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'DeskResume: periodic read-only desktop snapshot.' `
  -Force | Out-Null
$registered += "$TaskPath$TaskInterval"

if ($sessionTriggers.Count -gt 0) {
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskSessionEnd `
    -Action (Get-CollectorAction 'session-end') `
    -Trigger $sessionTriggers `
    -Settings $settings `
    -Principal $principal `
    -Description 'DeskResume: capture the session immediately before shutdown.' `
    -Force | Out-Null
  $registered += "$TaskPath$TaskSessionEnd"
} else {
  Write-Warning 'event triggers unavailable on this system; the pre-shutdown snapshot was NOT registered'
}

Write-Host '[deskresume] installed:'
foreach ($t in $registered) { Write-Host "  $t" }
Write-Host ''
Write-Host "[deskresume] interval ${IntervalSeconds}s, keeping $Keep snapshots."
Write-Host '[deskresume] verify with: schtasks /query /tn "\DeskResume\DeskResume-Interval"'
