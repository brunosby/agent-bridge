Option Explicit
Dim sh, fs, root
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
Sub CreateShortcut(folder)
  Dim link
  Set link = sh.CreateShortcut(fs.BuildPath(folder, "Agent Bridge.lnk"))
  link.TargetPath = fs.BuildPath(fs.GetSpecialFolder(1), "wscript.exe")
  link.Arguments = """" & fs.BuildPath(root,"Agent Bridge.vbs") & """"
  link.WorkingDirectory = root
  link.IconLocation = fs.BuildPath(root,"assets\windows\agent-bridge.ico") & ",0"
  link.Save
End Sub
CreateShortcut sh.SpecialFolders("Programs")
If WScript.Arguments.Named.Exists("desktop") Then CreateShortcut sh.SpecialFolders("Desktop")
