' run-hidden.vbs
'
' Launches the DeskResume collector with NO visible window.
'
' Why this file exists: a scheduled task that runs powershell.exe directly always
' creates a conhost console window first, and PowerShell only hides it after it
' has processed the -WindowStyle Hidden argument. On screen that is a brief
' console flash every capture interval, which is disruptive during normal use.
' WshShell.Run with window style 0 passes SW_HIDE in the STARTUPINFO structure,
' so the console window is never shown in the first place.
'
' Measured on Windows 10 22H2: the direct powershell.exe method produced a
' console window that was visible from ~100 ms, while this method produced no
' console window at all. See docs/capability-report.md.
'
' Usage: wscript.exe run-hidden.vbs <reason> [keep]
'   reason : manual | interval | session-end | boot | pre-restore
'   keep   : snapshots to retain (default 30)
'
' Exit codes: 2 = missing argument.

Option Explicit

Dim fso, shell, scriptDir, collector, ps, reason, keep, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If

' Resolve the collector relative to this script so the project can be moved
' without rewriting the scheduled task.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
collector = fso.BuildPath(scriptDir, "collect.ps1")

reason = WScript.Arguments(0)
keep = "30"
If WScript.Arguments.Count >= 2 Then
  If IsNumeric(WScript.Arguments(1)) Then keep = CStr(CLng(WScript.Arguments(1)))
End If

ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

' -Quiet: the collector is silent because there is no console to print to.
cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass" & _
      " -File """ & collector & """ -Reason " & reason & " -Keep " & keep & " -Quiet"

' 0 = hidden window (SW_HIDE in STARTUPINFO), False = do not wait.
shell.Run cmd, 0, False
