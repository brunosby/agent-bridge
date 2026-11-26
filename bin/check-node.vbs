Option Explicit
Dim sh, fs, dir, probe, version, message, choice, console, answer, exitCode
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
dir = fs.GetParentFolderName(WScript.ScriptFullName)
console = InStr(1, WScript.FullName, "cscript.exe", vbTextCompare) > 0
version = "not found"
On Error Resume Next
Set probe = sh.Exec("node """ & dir & "\ts-check.ts""")
If Err.Number = 0 Then
  answer = Trim(Replace(Replace(probe.StdOut.ReadAll, vbCr, ""), vbLf, ""))
  Do While probe.Status = 0
    WScript.Sleep 10
  Loop
  exitCode = probe.ExitCode
  If exitCode = 0 And answer = "ok" Then WScript.Quit 0
  Set probe = sh.Exec("node --version")
  version = Trim(Replace(Replace(probe.StdOut.ReadAll, vbCr, ""), vbLf, ""))
End If
On Error GoTo 0
message = "Found Node.js: " & version & ". Agent Bridge needs native TypeScript support (22.18+ on Node 22, 23.6+ on Node 23, or a newer major version)."
If console Then
  WScript.Echo message
  WScript.StdOut.Write "Install Node LTS (I), open the download site (O), or cancel (C)? "
  answer = UCase(Trim(WScript.StdIn.ReadLine))
Else
  choice = MsgBox(message & vbCrLf & vbCrLf & "Yes: Install Node LTS with WinGet" & vbCrLf & "No: Open the download site" & vbCrLf & "Cancel: Close", vbYesNoCancel + vbQuestion, "Agent Bridge setup")
  If choice = vbYes Then answer = "I"
  If choice = vbNo Then answer = "O"
End If
If answer = "I" Then
  sh.Run "cmd.exe /d /k winget install --id OpenJS.NodeJS.LTS --exact --source winget", 1, False
  If console Then
    WScript.Echo "After installation, close this window and reopen Agent Bridge from the shortcut."
  Else
    MsgBox "After installation, reopen Agent Bridge from the shortcut.", vbInformation, "Agent Bridge"
  End If
ElseIf answer = "O" Then
  sh.Run "https://nodejs.org/en/download"
End If
WScript.Quit 1
