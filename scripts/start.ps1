$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCommand) { $nodeCommand.Source } else { throw 'Node.js 22+ is required.' }
try { $existing = Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 2 } catch { $existing = $null }
if ($existing -and $existing.app -eq 'zhihu-mock-site') { Write-Host 'Service already running: http://127.0.0.1:3210'; exit 0 }
$logsDir = Join-Path $projectDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$entry = Join-Path $projectDir 'server\server.mjs'
Start-Process -FilePath $nodeExe -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'service.log') -RedirectStandardError (Join-Path $logsDir 'service-error.log') | Out-Null
Start-Sleep -Seconds 2
$status = Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 5
if ($status.app -ne 'zhihu-mock-site') { throw 'Port 3210 is occupied by a different application.' }
Write-Host 'Service ready: http://127.0.0.1:3210'
Write-Host 'Open the local mock site in your browser.'
