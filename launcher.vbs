Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & "C:\Users\orang\.gemini\antigravity\scratch\wedding-budget" & """ && start http://localhost:3001/index.html && node server.js", 1, False
