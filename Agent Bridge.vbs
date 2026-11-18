' Agent Bridge launcher without a console window.
' Double-click it: choose the project folder, and the page opens in the browser.
' Arguments are passed to the server, e.g.:  wscript "Agent Bridge.vbs" --resume
' Stop or restart the app from the buttons at the top of the page. Server output goes to logs\server.log.
Option Explicit

Dim sh, fso, dir, args, i, a, app, folder, logDir, cmd, hasCwd, hasResume

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js 20 or newer is required." & vbCrLf & "Install it from https://nodejs.org and try again.", vbExclamation, "Agent Bridge"
  WScript.Quit 1
End If

args = ""
hasCwd = False
hasResume = False
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If a = "--cwd" Then hasCwd = True
  If a = "--resume" Then hasResume = True
  args = args & " """ & a & """"
Next

If Not hasCwd And Not hasResume Then
  ' &H51 = file-system folders only (&H1) + edit box to type a path (&H10) + new-style dialog (&H40)
  Set app = CreateObject("Shell.Application")
  Set folder = app.BrowseForFolder(0, "Agent Bridge: choose the project folder", &H51, 0)
  If folder Is Nothing Then WScript.Quit 0
  args = args & " --cwd """ & folder.Self.Path & """"
End If

logDir = dir & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

cmd = "cmd /d /c node """ & dir & "\src\server.mjs""" & args & " --hidden >> """ & logDir & "\server.log"" 2>&1"
sh.Run cmd, 0, False
