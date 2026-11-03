#Requires -Version 5.1
<#
.SYNOPSIS
  DeskResume window placement helper.

.DESCRIPTION
  Reads a JSON array of placement requests from stdin and moves the matching
  windows back to their saved rectangles.

  Matching is by window title (exact, then prefix) with the saved window class
  as a tie-breaker. Handles are deliberately not reused: HWNDs are not stable
  across a reboot, so a stale handle would move the wrong window.

  Every target rectangle is clamped to a currently attached monitor. If the
  monitor a window was saved on is gone, the window lands on the nearest
  attached monitor instead of off-screen - that is the documented DeskResume
  behaviour, and it is reported per window.

  This script only calls SetWindowPos/ShowWindow. It never launches, closes or
  terminates anything.

.INPUTS
  A JSON file passed with -Json: array of { title, class, state, x, y, w, h, monitor }

.OUTPUTS
  A JSON file passed with -Out: { placed: [...], failed: [...], notes: [...] }

.NOTES
  Input and output travel through files, never through the console. PowerShell
  5.1 decodes piped stdin with the OEM code page, which mangles non-ASCII window
  titles (and therefore breaks title matching); explicit UTF-8 file reads avoid
  that entirely.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Json,
  [Parameter(Mandatory = $true)][string] $Out
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 writes stderr with the console's OEM code page (here GBK/936), not
# UTF-8. lib/restore.js collects that stream as a JS string and decodes it as UTF-8,
# so every Chinese character in a .NET exception message arrives as mojibake
# ("使用...时发生异常" became the garbage shown in the UI) and the actual cause is
# unreadable. Declaring the output encoding makes the bytes UTF-8, which is what
# the Node side already assumes. collect.ps1 has always done this; place.ps1 did
# not, which is why only placement errors were garbled.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$nativeSource = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DRPlace {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonProc cb, IntPtr data);
    public delegate bool MonProc(IntPtr mon, IntPtr hdc, ref RECT rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const int SW_RESTORE = 9;
    public const int SW_MAXIMIZE = 3;
    public const int SW_MINIMIZE = 6;

    public class Target {
        public long Hwnd;
        public string Title = "";
        public string ClassName = "";
        public bool Visible;
        public string MonitorDevice = "";
    }

    public static List<Target> List() {
        List<Target> list = new List<Target>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            StringBuilder tb = new StringBuilder(1024);
            GetWindowTextW(h, tb, tb.Capacity);
            string t = tb.ToString();
            if (t.Length == 0) return true;
            Target x = new Target();
            x.Hwnd = h.ToInt64();
            x.Title = t;
            StringBuilder cb = new StringBuilder(256);
            GetClassNameW(h, cb, cb.Capacity);
            x.ClassName = cb.ToString();
            x.Visible = IsWindowVisible(h);
            // Same encoding the collector writes ("l,t,r,b"), so a saved monitor
            // can be compared against a live one during matching.
            IntPtr mon = MonitorFromWindow(h, 2); // MONITOR_DEFAULTTONEAREST
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(mon, ref mi)) {
                x.MonitorDevice = mi.rcMonitor.Left + "," + mi.rcMonitor.Top + "," +
                                  mi.rcMonitor.Right + "," + mi.rcMonitor.Bottom;
            }
            list.Add(x);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /** All attached monitor work areas, so a stale target can be clamped. */
    public static List<RECT> Monitors() {
        List<RECT> list = new List<RECT>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr mon, IntPtr hdc, ref RECT r, IntPtr d) {
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(mon, ref mi)) list.Add(mi.rcWork);
            else list.Add(r);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static bool Move(long hwnd, int x, int y, int w, int h) {
        return SetWindowPos((IntPtr)hwnd, IntPtr.Zero, x, y, w, h,
                            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}
'@

Add-Type -TypeDefinition $nativeSource -ErrorAction Stop

# --- read requests ---
$utf8 = New-Object System.Text.UTF8Encoding($false)
$raw = [System.IO.File]::ReadAllText($Json, $utf8)
if ([string]::IsNullOrWhiteSpace($raw)) {
  [System.IO.File]::WriteAllText($Out, '{"placed":[],"failed":[],"notes":["no placement requests received"]}', $utf8)
  exit 0
}
# ConvertFrom-Json does NOT hand back the array itself: on Windows PowerShell 5.1
# it writes the whole array to the pipeline as ONE object, so
# `@($raw | ConvertFrom-Json)` wraps that array in a second array and
# `$requests.Count` is 1 — a single "request" whose .title is an Object[] holding
# every title. The old code then called .Substring() on that Object[], place.ps1
# died with exit 1, and the restore placed zero windows while reporting only an
# opaque ArgumentOutOfRangeException. A one-request array happened to survive
# (its element unwrapped to a PSCustomObject), which is exactly why the
# one-window smoke test passed while every real restore failed. Unroll explicitly.
$parsed = $raw | ConvertFrom-Json
$requests = @($parsed | ForEach-Object { $_ })

$targets = [DRPlace]::List()
$monitors = [DRPlace]::Monitors()
$placed = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
$used = @{}

function Clamp-ToMonitors([int] $x, [int] $y, [int] $w, [int] $h) {
  foreach ($m in $monitors) {
    $mw = $m.Right - $m.Left; $mh = $m.Bottom - $m.Top
    $cx = [Math]::Max($m.Left, [Math]::Min($x, $m.Right - 80))
    $cy = [Math]::Max($m.Top, [Math]::Min($y, $m.Bottom - 80))
    # Is any part of the rectangle on this monitor?
    if ($cx -ge $m.Left -and $cx -lt $m.Right -and $cy -ge $m.Top -and $cy -lt $m.Bottom) {
      $nw = [Math]::Min($w, $mw); $nh = [Math]::Min($h, $mh)
      return @{ x = $cx; y = $cy; w = $nw; h = $nh; clamped = ($cx -ne $x -or $cy -ne $y -or $nw -ne $w -or $nh -ne $h) }
    }
  }
  # No overlap at all: park it on the first attached monitor.
  if ($monitors.Count -gt 0) {
    $m = $monitors[0]
    return @{ x = $m.Left; y = $m.Top; w = [Math]::Min($w, $m.Right - $m.Left); h = [Math]::Min($h, $m.Bottom - $m.Top); clamped = $true }
  }
  return @{ x = $x; y = $y; w = $w; h = $h; clamped = $false }
}

# Matching is multi-factor and ordered by confidence. A saved window is
# identified by title, and the window class plus the monitor it was saved on are
# used to choose between candidates rather than to reject them outright: after a
# reboot a title can legitimately change (an IDE appends the open file, a browser
# window is renamed by the page), so a strict all-factors match would silently
# lose windows that are in fact the same window.
#
#   tier 1  exact title        (+ class, + monitor)   best evidence
#   tier 2  exact title        (class/monitor may differ)
#   tier 3  prefix title       (+ class)
#   tier 4  prefix title       (title only)           weakest accepted
#
# A window claimed in this pass is never reused, so two saved entries cannot
# both land on one window.
function Get-MatchScore($t, $req, [bool] $exact) {
  $score = if ($exact) { 100 } else { 10 }
  if ($req.class -and ($t.ClassName -ceq [string]$req.class)) { $score += 20 }
  if ($req.monitor -and ($t.MonitorDevice -ceq [string]$req.monitor)) { $score += 5 }
  return $score
}

foreach ($req in $requests) {
  # Coerce once, up front. A request that is not an object, or whose title is not
  # a scalar, used to reach the matching code as a raw object and throw deep in
  # the loop — killing every remaining window's placement for one bad entry.
  $reqTitle = if ($null -ne $req -and $req -isnot [array]) { [string]$req.title } else { '' }
  if (-not $reqTitle) { continue }
  # Echoed back on both success and failure so the caller can tell WHICH requests
  # are still unmatched after a pass, instead of re-matching titles itself. A
  # prefix match makes titles ambiguous, so the round bookkeeping in
  # lib/restore.js needs this id rather than a title comparison.
  $reqId = if ($null -ne $req.id) { [int]$req.id } else { -1 }

  $match = $null
  $best = -1
  foreach ($t in $targets) {
    if ($used.ContainsKey($t.Hwnd)) { continue }
    $exact = ($t.Title -ceq $reqTitle)
    $prefix = (-not $exact) -and
              $t.Title.StartsWith($reqTitle, [StringComparison]::OrdinalIgnoreCase)
    if (-not $exact -and -not $prefix) { continue }
    $score = Get-MatchScore $t $req $exact
    if ($score -gt $best) { $best = $score; $match = $t }
  }

  if (-not $match) {
    # Report what was actually available: after a reboot the useful diagnostic is
    # "which windows did exist", not merely that this one did not match.
    $candidates = @()
    $probe = $reqTitle.Substring(0, [Math]::Min(8, $reqTitle.Length))
    foreach ($t in $targets) {
      if ($used.ContainsKey($t.Hwnd)) { continue }
      if ($t.Title -like ("*" + $probe + "*")) {
        $candidates += $t.Title
      }
      if ($candidates.Count -ge 5) { break }
    }
    $entry = @{ id = $reqId; title = $reqTitle; error = 'window not found' }
    if ($candidates.Count -gt 0) { $entry.candidates = $candidates }
    [void]$failed.Add($entry)
    continue
  }
  $used[$match.Hwnd] = $true

  $c = Clamp-ToMonitors ([int]$req.x) ([int]$req.y) ([int]$req.w) ([int]$req.h)

  $ok = $false
  if ($req.state -eq 'maximized') {
    [void][DRPlace]::ShowWindow([IntPtr]$match.Hwnd, [DRPlace]::SW_RESTORE)
    $ok = [DRPlace]::Move($match.Hwnd, $c.x, $c.y, $c.w, $c.h)
    if ($ok) { [void][DRPlace]::ShowWindow([IntPtr]$match.Hwnd, [DRPlace]::SW_MAXIMIZE) }
  } elseif ($req.state -eq 'minimized') {
    $ok = [DRPlace]::Move($match.Hwnd, $c.x, $c.y, $c.w, $c.h)
    if ($ok) { [void][DRPlace]::ShowWindow([IntPtr]$match.Hwnd, [DRPlace]::SW_MINIMIZE) }
  } else {
    [void][DRPlace]::ShowWindow([IntPtr]$match.Hwnd, [DRPlace]::SW_RESTORE)
    $ok = [DRPlace]::Move($match.Hwnd, $c.x, $c.y, $c.w, $c.h)
  }

  if ($ok) {
    [void]$placed.Add(@{
      id = $reqId
      title = $match.Title
      x = $c.x; y = $c.y; w = $c.w; h = $c.h
      state = $req.state
      clamped = [bool]$c.clamped
      matchedTitle = $match.Title
      matchScore = $best
      classMatched = [bool]($req.class -and ($match.ClassName -ceq [string]$req.class))
    })
    if ($match.Title -cne $reqTitle) {
      [void]$notes.Add(("Window matched by prefix: saved '{0}' -> live '{1}'." -f $reqTitle, $match.Title))
    }
    if ($c.clamped) {
      [void]$notes.Add(("Window '{0}' was saved off the current monitors; moved to the nearest attached display." -f $match.Title))
    }
  } else {
    [void]$failed.Add(@{ id = $reqId; title = $match.Title; error = 'SetWindowPos failed' })
  }
}

if ($monitors.Count -eq 0) {
  [void]$notes.Add('No attached monitors were detected; skipping all placement.')
}

$result = [pscustomobject]@{
  placed = @($placed)
  failed = @($failed)
  notes  = @($notes)
} | ConvertTo-Json -Depth 5 -Compress

# Written as UTF-8 without BOM so the Node side can JSON.parse it directly.
[System.IO.File]::WriteAllText($Out, $result, $utf8)
exit 0
