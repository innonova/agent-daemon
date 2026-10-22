# Installs the daemon on Windows as a scheduled task that runs at the user's
# logon, in the interactive session: the agents it starts then see the
# desktop, which an SSH session (session 0) does not. Builds, copies a
# production install to %LOCALAPPDATA%\agent-daemon\lib, writes default
# profiles to %APPDATA%\agent-daemon\profiles if none exist, registers the
# task "agent-daemon" and starts it if the user is logged on. Re-running
# updates the install and restarts the task.
#
# Run from a PowerShell as the user who will own the agents:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$Lib    = Join-Path $env:LOCALAPPDATA 'agent-daemon\lib'
$State  = Join-Path $env:LOCALAPPDATA 'agent-daemon'
$Config = Join-Path $env:APPDATA 'agent-daemon'
$Node   = (Get-Command node).Source
$Task   = 'agent-daemon'

Write-Host "building in $Root"
Push-Location $Root
try { npm run build | Out-Null; if ($LASTEXITCODE) { throw "npm run build failed ($LASTEXITCODE)" } } finally { Pop-Location }

# Stop a running install first: Windows will not let npm replace files a
# process holds open, and a half-replaced node_modules is worse than none.
if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  # Windows PowerShell 5 has no CommandLine on Get-Process; WMI has it
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*agent-daemon\lib\dist\main.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false
}

New-Item -ItemType Directory -Force $Lib, $State, (Join-Path $Config 'profiles') | Out-Null
Remove-Item -Recurse -Force (Join-Path $Lib 'dist') -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $Root 'dist') $Lib
Copy-Item (Join-Path $Root 'package.json'), (Join-Path $Root 'package-lock.json') $Lib
Push-Location $Lib
try { npm ci --omit=dev --ignore-scripts | Out-Null; if ($LASTEXITCODE) { throw "npm ci failed ($LASTEXITCODE)" } } finally { Pop-Location }

function Write-Profile($name, $json) {
  $f = Join-Path $Config "profiles\$name.json"
  # UTF-8 without a byte-order mark: Set-Content -Encoding UTF8 writes one, which is not JSON
  if (-not (Test-Path $f)) { Write-Host "writing default profile $f"; [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding $false)) }
}
Write-Profile claude '{
  "description": "Claude Code, headless stream-json",
  "command": "claude",
  "args": ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages"]
}'
Write-Profile codex '{
  "description": "Codex app-server (JSON-RPC over stdio)",
  "command": "codex",
  "args": ["app-server"]
}'
Write-Profile copilot '{
  "description": "GitHub Copilot CLI as an ACP server",
  "command": "copilot",
  "args": ["--acp"]
}'
Write-Profile shell '{
  "description": "a shell that takes one command as its argument, for the manager''s exec (am exec <host> -- <command>); runs in this session, the logged-in desktop",
  "command": "powershell.exe",
  "args": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
}'

# The task does not inherit this shell's PATH, so bake in the one this
# script was run with (it must be able to find the agent CLIs). A .vbs
# launcher runs the .cmd without a console window on the desktop.
$Log = Join-Path $State 'daemon.log'
$Cmd = Join-Path $Lib 'run.cmd'
@(
  '@echo off',
  'set AGENT_DAEMON_LISTEN=127.0.0.1:4267',
  'set ELECTRON_RUN_AS_NODE=',
  "set PATH=$env:USERPROFILE\.local\bin;$env:PATH", # where Claude Code's native installer puts claude.exe
  "`"$Node`" `"$Lib\dist\main.js`" >> `"$Log`" 2>&1"
) | Set-Content -Path $Cmd -Encoding ASCII
$Vbs = Join-Path $Lib 'run.vbs'
"CreateObject(""WScript.Shell"").Run """"""$Cmd"""""", 0, False" | Set-Content -Path $Vbs -Encoding ASCII

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Vbs`"" -WorkingDirectory $Lib
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'agent-daemon: holds headless agent CLI sessions (interactive session)' | Out-Null
Write-Host "registered scheduled task $Task (at logon of $env:USERNAME, interactive)"

$sessions = cmd /c "query user 2>nul"
$loggedOn = ($sessions | Out-String) -match "(?m)^\s*>?$env:USERNAME\s"
if ($loggedOn) {
  Start-ScheduledTask -TaskName $Task
  Start-Sleep -Seconds 3
  try { (Invoke-WebRequest http://127.0.0.1:4267/health -UseBasicParsing).Content } catch { Write-Warning "no answer on :4267 yet; see $Log" }
} else {
  Write-Warning "$env:USERNAME is not logged on at the console; the task starts at the next logon (auto-logon keeps a VM's desktop session up)"
}
Write-Host "log: $Log"
Write-Host "profiles: $Config\profiles (restart the task to reload)"
