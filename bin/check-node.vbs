Option Explicit
Dim sh, fs, dir, capture, outputPath, version, message, choice, console, answer, exitCode
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
dir = fs.GetParentFolderName(WScript.ScriptFullName)
console = InStr(1, WScript.FullName, "cscript.exe", vbTextCompare) > 0
version = "not found"
' Run both probes with the console hidden, including when launched by wscript.
sh.CurrentDirectory = dir
outputPath = fs.BuildPath(fs.GetSpecialFolder(2), fs.GetTempName())
Set capture = fs.CreateTextFile(outputPath, False)
capture.Close
sh.Environment("Process")("BRIDGE_NODE_PROBE_OUT") = outputPath
Function ReadProbe(command, ByRef result)
  Dim stream
  ReadProbe = sh.Run("cmd.exe /d /v:off /c " & command & " >""%BRIDGE_NODE_PROBE_OUT%"" 2>nul", 0, True)
  Set stream = fs.OpenTextFile(outputPath, 1)
  result = ""
  If Not stream.AtEndOfStream Then result = Trim(Replace(Replace(stream.ReadAll, vbCr, ""), vbLf, ""))
  stream.Close
End Function
exitCode = ReadProbe("node ts-check.ts", answer)
If exitCode = 0 And answer = "ok" Then
  fs.DeleteFile outputPath
  WScript.Quit 0
End If
If ReadProbe("node --version", answer) = 0 Then version = answer
fs.DeleteFile outputPath
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
