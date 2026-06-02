Option Explicit

Dim fso, shell, scriptDir, projectRoot, ps1, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
ps1 = fso.BuildPath(projectRoot, "src\tray\wx-summary-tray.ps1")

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(ps1)
shell.CurrentDirectory = projectRoot
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
