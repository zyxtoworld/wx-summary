Option Explicit

Dim fso, shell, scriptDir, projectRoot, ps1, command, systemRoot, powerShellExe

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
ps1 = fso.BuildPath(projectRoot, "src\tray\wx-summary-tray.ps1")
systemRoot = shell.ExpandEnvironmentStrings("%SystemRoot%")
powerShellExe = fso.BuildPath(systemRoot, "System32\WindowsPowerShell\v1.0\powershell.exe")
If Not fso.FileExists(powerShellExe) Then
  Fail "Trusted Windows PowerShell was not found."
End If
If Not fso.FileExists(ps1) Then
  Fail "The wx-summary tray script is missing: " & ps1
End If

command = Quote(powerShellExe) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(ps1)
shell.CurrentDirectory = projectRoot
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  Dim launchError
  launchError = Err.Description
  On Error GoTo 0
  Fail "Could not start the wx-summary tray: " & launchError
End If
On Error GoTo 0

Sub Fail(message)
  shell.Popup message, 0, "wx-summary startup failed", 16
  WScript.Quit 1
End Sub

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
