Option Explicit

Dim shell, fso, root, watchdog, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
watchdog = fso.BuildPath(fso.GetParentFolderName(root), "statusline\watchdog.ps1")
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(watchdog)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
