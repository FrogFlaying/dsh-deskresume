#Requires -Version 5.1
<#
.SYNOPSIS
  DeskResume read-only desktop snapshot collector.

.DESCRIPTION
  Captures what is currently open on the desktop and writes one JSON snapshot.
  THIS SCRIPT IS READ-ONLY: it never launches, closes, moves or terminates
  anything. It only reads window state, process metadata and Explorer paths.

  It exists to answer one question before any restorer is written:
  "on this machine, how much of the desktop can we actually observe?"

  Capture channels (each degrades independently):
    1. EnumWindows + GetWindowRect/GetWindowPlacement  -> window geometry & state
    2. DwmGetWindowAttribute(DWMWA_CLOAKED)            -> hide UWP/ghost windows
    3. MonitorFromWindow + GetMonitorInfo              -> which monitor
    4. Get-WmiObject Win32_Process                     -> exe path + command line
    5. Shell.Application COM                           -> Explorer folder paths
    6. NtQueryInformationProcess + ReadProcessMemory   -> shell/terminal cwd (best effort)

.PARAMETER OutFile
  Where to write the JSON snapshot. Default: <script dir>\..\data\<timestamp>.json

.PARAMETER Reason
  Why the snapshot was taken: manual | interval | session-end | boot | pre-restore

.PARAMETER IncludeTerminalCwd
  Attempt PEB-based working-directory reads for shells/terminals. Off by default
  because it opens each target process with PROCESS_VM_READ.

.PARAMETER Keep
  How many snapshots to retain in the data folder (0 = keep everything).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector\collect.ps1 -Reason manual

.NOTES
  Windows PowerShell 5.1 compatible. Add-Type compiles with the C# 5 compiler,
  so no string interpolation, expression-bodied members or null-conditional
  operators are used in the embedded type definitions below.
#>
[CmdletBinding()]
param(
  [string] $OutFile,
  [ValidateSet('manual', 'interval', 'session-end', 'boot', 'pre-restore')]
  [string] $Reason = 'manual',
  [switch] $IncludeTerminalCwd,
  [int] $Keep = 30,
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $RootDir 'data'
if (-not (Test-Path -LiteralPath $DataDir)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}
if (-not $OutFile) {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $OutFile = Join-Path $DataDir ("snapshot-$stamp-$Reason.json")
}

function Write-Log([string] $msg) {
  if (-not $Quiet) { Write-Host "[deskresume] $msg" }
}

# --- native helpers ---
$nativeSource = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DRWin {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length; public int flags; public int showCmd;
        public POINT ptMinPosition; public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    }

    public class WinInfo {
        public long Hwnd;
        public uint Pid;
        public string Title = "";
        public string ClassName = "";
        public bool Visible;
        public int X, Y, W, H;
        public int NormX, NormY, NormW, NormH;
        public int ShowCmd;
        public int Cloaked;
        public string MonitorDevice = "";
        public bool Minimized;
        public bool Maximized;
    }

    // ShowCmd values: 1 = normal, 2 = minimized, 3 = maximized
    public static List<WinInfo> Scan() {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            StringBuilder tb = new StringBuilder(1024);
            GetWindowTextW(h, tb, tb.Capacity);
            string title = tb.ToString();
            // Untitled windows are returned too, so the caller can report how many
            // were dropped rather than silently losing them here.

            WinInfo w = new WinInfo();
            w.Hwnd = h.ToInt64();
            w.Title = title;
            w.Visible = IsWindowVisible(h);

            StringBuilder cb = new StringBuilder(256);
            GetClassNameW(h, cb, cb.Capacity);
            w.ClassName = cb.ToString();

            uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            w.Pid = pid;

            RECT r;
            if (GetWindowRect(h, out r)) {
                w.X = r.Left; w.Y = r.Top;
                w.W = r.Right - r.Left; w.H = r.Bottom - r.Top;
            }

            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (GetWindowPlacement(h, ref wp)) {
                w.ShowCmd = wp.showCmd;
                w.NormX = wp.rcNormalPosition.Left;
                w.NormY = wp.rcNormalPosition.Top;
                w.NormW = wp.rcNormalPosition.Right - wp.rcNormalPosition.Left;
                w.NormH = wp.rcNormalPosition.Bottom - wp.rcNormalPosition.Top;
            }
            w.Minimized = IsIconic(h);
            w.Maximized = IsZoomed(h);

            // DWMWA_CLOAKED = 14. Cloaked windows are "visible" to the API but not
            // on screen (suspended UWP apps, other virtual desktops).
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
            w.Cloaked = cloaked;

            IntPtr mon = MonitorFromWindow(h, 2); // MONITOR_DEFAULTTONEAREST
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(mon, ref mi)) {
                w.MonitorDevice = mi.rcMonitor.Left + "," + mi.rcMonitor.Top + "," +
                                  mi.rcMonitor.Right + "," + mi.rcMonitor.Bottom;
            }

            list.Add(w);
            return true;
        }, IntPtr.Zero);
        return list;
    }
}

public static class DRProc {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);

    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;

    // x64 layout: PEB->ProcessParameters at +0x20,
    // RTL_USER_PROCESS_PARAMETERS->CurrentDirectory (CURDIR) at +0x38,
    // UNICODE_STRING.Buffer at +0x40.
    public static string GetWorkingDirectory(uint pid) {
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            byte[] pbi = new byte[48];
            int ret;
            if (NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret) != 0) return null;
            long peb = BitConverter.ToInt64(pbi, 8);
            if (peb == 0) return null;

            IntPtr got;
            byte[] ptr = new byte[8];
            if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), ptr, 8, out got)) return null;
            long parms = BitConverter.ToInt64(ptr, 0);
            if (parms == 0) return null;

            byte[] cur = new byte[16];
            if (!ReadProcessMemory(h, (IntPtr)(parms + 0x38), cur, 16, out got)) return null;
            ushort len = BitConverter.ToUInt16(cur, 0);
            long buf = BitConverter.ToInt64(cur, 8);
            if (len == 0 || len > 4096 || buf == 0) return null;

            byte[] raw = new byte[len];
            if (!ReadProcessMemory(h, (IntPtr)buf, raw, len, out got)) return null;
            return Encoding.Unicode.GetString(raw);
        } catch {
            return null;
        } finally {
            CloseHandle(h);
        }
    }
}
'@

Write-Log 'compiling native helpers...'
Add-Type -TypeDefinition $nativeSource -ErrorAction Stop

# --- capture ---
$capturedAt = Get-Date
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Log 'enumerating windows...'
$rawWindows = [DRWin]::Scan()

# Process metadata. Get-CimInstance is blocked in some locked-down sessions, so
# fall back to Get-WmiObject, then to Get-Process (which has no command line).
$procMap = @{}
$procChannel = 'none'
try {
  $procs = Get-WmiObject -Class Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine -ErrorAction Stop
  foreach ($p in $procs) { $procMap[[int]$p.ProcessId] = $p }
  $procChannel = 'wmi'
} catch {
  Write-Log "WMI unavailable ($($_.Exception.Message)); falling back to Get-Process (no command line)"
  try {
    foreach ($p in Get-Process) { $procMap[[int]$p.Id] = $p }
    $procChannel = 'get-process'
  } catch { $procChannel = 'none' }
}
Write-Log "process metadata channel: $procChannel ($($procMap.Count) processes)"

# Screen list (for clamping restored coordinates onto an attached monitor).
$screens = @()
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $screens += [ordered]@{
      device   = $s.DeviceName
      primary  = [bool]$s.Primary
      bounds   = [ordered]@{ x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height }
      workArea = [ordered]@{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; w = $s.WorkingArea.Width; h = $s.WorkingArea.Height }
    }
  }
} catch { Write-Log "screen enumeration failed: $($_.Exception.Message)" }

# Shell.Application COM gives the folders Explorer has open. On Windows 10 each
# Explorer window is one folder; on Windows 11 the same call is per-window too.
$explorerWindows = @()
$explorerChannel = 'com'
try {
  $shell = New-Object -ComObject Shell.Application
  foreach ($w in @($shell.Windows())) {
    $path = $null; $url = $null; $hwnd = $null
    # Each property read is guarded: a window mid-navigation can throw here.
    try { $path = $w.Document.Folder.Self.Path } catch { }
    try { $url = $w.LocationURL } catch { }
    try { $hwnd = [int64]$w.HWND } catch { $hwnd = $null }
    if ($path) {
      $explorerWindows += [ordered]@{
        path = $path
        url  = $url
        hwnd = $hwnd
      }
    }
  }
} catch {
  $explorerChannel = 'unavailable'
  Write-Log "Shell.Application COM failed: $($_.Exception.Message)"
}

# Working directories for shells/terminals (best effort).
#
# A terminal window usually belongs to a host (WindowsTerminal.exe, conhost.exe,
# or the emulator) while the process that actually knows the cwd is a *child*
# shell (powershell.exe, cmd.exe, wsl.exe). Reading the host's PEB therefore
# yields the host's own directory, not the user's. So: walk down the process tree
# from the window's process and take the deepest shell descendant.
#
# The walk is deliberately restricted to windows that ARE terminal surfaces.
# Many unrelated apps (Chrome, IDEs) spawn an incidental cmd.exe child for a
# build step or an extension helper; treating that as "the terminal's folder"
# would make the restorer relaunch the app in a meaningless directory.
$terminalCwd = @{}
$cwdAttempted = 0; $cwdOk = 0
if ($IncludeTerminalCwd) {
  $shellBases = @('powershell', 'pwsh', 'cmd', 'wsl', 'bash', 'ubuntu', 'nu', 'fish', 'zsh')
  $hostBases  = @('windowsterminal', 'wt', 'conhost', 'openconsole', 'mintty',
                  'alacritty', 'wezterm', 'tabby', 'fluentterminal', 'conemu64', 'cmder')
  $consoleClasses = @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS',
                      'VirtualConsoleClass', 'mintty')

  # Children index, built once.
  $childrenOf = @{}
  foreach ($p in $procMap.Values) {
    $ppid = [int]$p.ParentProcessId
    if ($ppid -le 0) { continue }
    if (-not $childrenOf.ContainsKey($ppid)) { $childrenOf[$ppid] = New-Object System.Collections.ArrayList }
    [void]$childrenOf[$ppid].Add([int]$p.ProcessId)
  }

  # Depth-first: return the deepest shell descendant with a readable cwd.
  # Results are memoised per process, because the walk would otherwise repeat the
  # same subtree once for every window.
  # ($pid is a read-only PowerShell automatic variable, hence $procId.)
  $cwdCache = @{}
  function Find-ShellCwd([int] $procId, [int] $depth) {
    if ($depth -gt 6) { return $null }
    if ($cwdCache.ContainsKey($procId)) { return $cwdCache[$procId] }
    $best = $null
    if ($childrenOf.ContainsKey($procId)) {
      foreach ($child in $childrenOf[$procId]) {
        $cn = $null
        if ($procMap.ContainsKey($child)) { $cn = $procMap[$child].Name }
        if ($cn) {
          $cb = [System.IO.Path]::GetFileNameWithoutExtension($cn)
          if ($shellBases -contains $cb) {
            $script:cwdAttempted++
            $c = [DRProc]::GetWorkingDirectory([uint32]$child)
            if ($c) { $best = $c }
          }
        }
        $deeper = Find-ShellCwd $child ($depth + 1)
        if ($deeper) { $best = $deeper }
      }
    }
    $cwdCache[$procId] = $best
    return $best
  }

  foreach ($w in $rawWindows) {
    $pname = $null
    if ($procMap.ContainsKey([int]$w.Pid)) { $pname = $procMap[[int]$w.Pid].Name }
    if (-not $pname) { continue }
    $base = [System.IO.Path]::GetFileNameWithoutExtension($pname)

    # Case 1: the window's own process is a shell (e.g. a bare console window).
    if ($shellBases -contains $base) {
      $script:cwdAttempted++
      $cwd = [DRProc]::GetWorkingDirectory([uint32]$w.Pid)
      if ($cwd) { $terminalCwd[[string]$w.Pid] = $cwd; $script:cwdOk++; continue }
    }

    # Case 2: the window is a terminal surface; look down for the shell in it.
    $isTerminalSurface = ($hostBases -contains $base) -or
                         ($consoleClasses -contains [string]$w.ClassName)
    if (-not $isTerminalSurface) { continue }

    $found = Find-ShellCwd ([int]$w.Pid) 0
    if ($found) { $terminalCwd[[string]$w.Pid] = $found; $script:cwdOk++ }
  }
  Write-Log "terminal cwd: $cwdOk/$cwdAttempted readable"
}

# --- assemble ---
$ownPid = $PID
$windows = New-Object System.Collections.ArrayList
$skippedNoTitle = 0
$skippedCloaked = 0
$skippedInvisible = 0

foreach ($w in $rawWindows) {
  if (-not $w.Title) { $skippedNoTitle++; continue }
  if ($w.Cloaked -ne 0) { $skippedCloaked++; continue }
  if (-not $w.Visible) { $skippedInvisible++; continue }
  if ($w.Pid -eq $ownPid) { continue }

  $entry = [ordered]@{
    hwnd    = ('0x{0:X}' -f $w.Hwnd)
    pid     = [int]$w.Pid
    title   = $w.Title
    class   = $w.ClassName
    exe     = $null
    name    = $null
    commandLine = $null
    args    = @()
    state   = if ($w.Minimized) { 'minimized' } elseif ($w.Maximized) { 'maximized' } else { 'normal' }
    # rect = where it is now; normalRect = where it returns when restored.
    rect       = [ordered]@{ x = $w.X; y = $w.Y; w = $w.W; h = $w.H }
    normalRect = [ordered]@{ x = $w.NormX; y = $w.NormY; w = $w.NormW; h = $w.NormH }
    monitor    = $w.MonitorDevice
    cwd        = $null
  }

  if ($procMap.ContainsKey([int]$w.Pid)) {
    $p = $procMap[[int]$w.Pid]
    if ($p.ExecutablePath) { $entry.exe = $p.ExecutablePath }
    if ($p.Name) { $entry.name = $p.Name }
    if ($p.CommandLine) {
      $entry.commandLine = $p.CommandLine
      # Split the command line into an argv-ish list. Best effort: honours double
      # quotes, does not try to reimplement the full CommandLineToArgvW grammar.
      $cl = $p.CommandLine
      if ($cl.Length -gt 0 -and $cl[0] -eq '"') {
        $rest = $cl.Substring(1)
        $q = $rest.IndexOf('"')
        if ($q -ge 0) { $cl = $rest.Substring($q + 1).TrimStart() }
      } else {
        $sp = $cl.IndexOf(' ')
        if ($sp -ge 0) { $cl = $cl.Substring($sp + 1).TrimStart() } else { $cl = '' }
      }
      if ($cl) {
        $args = New-Object System.Collections.ArrayList
        foreach ($m in [regex]::Matches($cl, '"([^"]*)"|(\S+)')) {
          $v = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
          [void]$args.Add($v)
        }
        $entry.args = @($args)
      }
    }
  }
  if ($terminalCwd.ContainsKey([string]$w.Pid)) { $entry.cwd = $terminalCwd[[string]$w.Pid] }

  [void]$windows.Add($entry)
}

$sw.Stop()

# --- stats ---
# The window list holds OrderedDictionary entries, so stats are computed with
# explicit key access rather than Select-Object -ExpandProperty (which only
# understands real properties).
function Get-KeyCount($items, [string] $key) {
  $n = 0
  foreach ($i in $items) { if ($i[$key]) { $n++ } }
  return $n
}
$withExe = Get-KeyCount $windows 'exe'
$withCmd = Get-KeyCount $windows 'commandLine'
$withCwd = Get-KeyCount $windows 'cwd'
$withArgs = 0
$minimized = 0; $maximized = 0
$pidSet = @{}
foreach ($i in $windows) {
  if ($i['args'].Count -gt 0) { $withArgs++ }
  if ($i['state'] -eq 'minimized') { $minimized++ }
  if ($i['state'] -eq 'maximized') { $maximized++ }
  $pidSet[[string]$i['pid']] = $true
}
$distinctPids = $pidSet.Count

$os = $null
try {
  $osv = Get-WmiObject -Class Win32_OperatingSystem -ErrorAction Stop
  $os = [ordered]@{ caption = $osv.Caption; version = $osv.Version; build = $osv.BuildNumber; arch = $osv.OSArchitecture }
} catch {
  try {
    $k = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $os = [ordered]@{ caption = $k.ProductName; version = $k.DisplayVersion; build = "$($k.CurrentBuild).$($k.UBR)"; arch = $env:PROCESSOR_ARCHITECTURE }
  } catch { $os = [ordered]@{ caption = 'unknown'; version = 'unknown'; build = 'unknown'; arch = $env:PROCESSOR_ARCHITECTURE } }
}

$snapshot = [ordered]@{
  schemaVersion = 1
  capturedAt    = $capturedAt.ToString('o')
  reason        = $Reason
  durationMs    = [int]$sw.ElapsedMilliseconds
  host          = [ordered]@{
    os          = $os
    user        = $env:USERNAME
    computer    = $env:COMPUTERNAME
    screens     = $screens
    sessionId   = $ownPid
  }
  channels      = [ordered]@{
    windowEnum  = 'user32.EnumWindows'
    processMeta = $procChannel
    explorer    = $explorerChannel
    terminalCwd = if ($IncludeTerminalCwd) { 'peb' } else { 'disabled' }
  }
  windows       = @($windows)
  explorer      = @($explorerWindows)
  stats         = [ordered]@{
    windows             = $windows.Count
    distinctProcesses   = $distinctPids
    withExePath         = $withExe
    withCommandLine     = $withCmd
    withArgs            = $withArgs
    withTerminalCwd     = $withCwd
    minimized           = $minimized
    maximized           = $maximized
    explorerWindows     = $explorerWindows.Count
    screens             = $screens.Count
    rawEnumerated       = $rawWindows.Count
    skippedNoTitle      = $skippedNoTitle
    skippedCloaked      = $skippedCloaked
    skippedInvisible    = $skippedInvisible
    cwdAttempted        = $cwdAttempted
    cwdReadable         = $cwdOk
  }
}

# UTF-8 without BOM: the Node side parses this with JSON.parse.
$json = $snapshot | ConvertTo-Json -Depth 8
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutFile, $json, $utf8)

# Retention: keep the newest $Keep snapshots in the data folder.
if ($Keep -gt 0) {
  $old = Get-ChildItem -LiteralPath $DataDir -Filter 'snapshot-*.json' |
         Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
  foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
}

Write-Log ("snapshot written: {0}" -f $OutFile)
Write-Log ("windows={0} processes={1} exe={2} cmdline={3} explorer={4} in {5}ms" -f `
  $windows.Count, $distinctPids, $withExe, $withCmd, $explorerWindows.Count, $sw.ElapsedMilliseconds)

# Emit a compact summary on stdout so callers can act without re-reading the file.
[pscustomobject]@{
  ok      = $true
  outFile = $OutFile
  reason  = $Reason
  stats   = $snapshot.stats
  channels = $snapshot.channels
} | ConvertTo-Json -Depth 5 -Compress
