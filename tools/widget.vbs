' Launch the desktop widget without any console window.
' args: 0 = powershell.exe, 1 = widget.ps1, 2 = base url
' The second parameter of Run (0 = hidden) is what keeps cmd/powershell from flashing.
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """ -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(1) & """ -Base " & WScript.Arguments(2)
sh.Run cmd, 0, False
