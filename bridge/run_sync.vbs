' Runs the sync with no console window, so a black box does not blink
' onto the shop PC's screen every five minutes all day. Output still
' goes to bridge.log.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "python """ & here & "\pyzk_bridge.py""", 0, False
