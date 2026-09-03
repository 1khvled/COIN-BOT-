Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Make sure the log folder exists before redirecting output to it
If Not fso.FolderExists(scriptDir & "\logs") Then
  fso.CreateFolder(scriptDir & "\logs")
End If

' Prefer the hidden runtime copy of node (neutral name, low profile),
' then bundled node, then standard installs.
nodePath = ""
runtimeNode = env("ProgramData") & "\Runtime\rtnode.exe"
If fso.FileExists(runtimeNode) Then
  nodePath = runtimeNode
ElseIf fso.FileExists(scriptDir & "\node.exe") Then
  nodePath = scriptDir & "\node.exe"
ElseIf fso.FileExists(env("ProgramFiles") & "\nodejs\node.exe") Then
  nodePath = env("ProgramFiles") & "\nodejs\node.exe"
ElseIf fso.FileExists(env("ProgramFiles(x86)") & "\nodejs\node.exe") Then
  nodePath = env("ProgramFiles(x86)") & "\nodejs\node.exe"
End If

If nodePath = "" Then
  ' Fall back to PATH lookup
  nodePath = "node"
End If

' Cap the JS heap so the bot stays light on RAM (Chromium does the heavy
' lifting in its own process during collection).
nodeArgs = "--max-old-space-size=128"

' Keep the bot alive: if node exits, wait and restart.
' Create the file logs\.stop to disable the restart loop.
Do
  WshShell.Run "cmd /c """ & nodePath & """ " & nodeArgs & " src\index.js >> logs\bot.log 2>&1", 0, True
  If fso.FileExists(scriptDir & "\logs\.stop") Then
    Exit Do
  End If
  WScript.Sleep 5000
Loop
