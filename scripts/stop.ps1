$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$expectedEntry = [IO.Path]::GetFullPath((Join-Path $projectDir 'server\server.mjs'))
$listeners = @(Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue)
if (-not $listeners.Count) { Write-Host 'Service is not running.'; exit 0 }
foreach ($listener in $listeners) {
    $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess)
    $normalizedCommand = ($taskProcess.CommandLine -replace '/', '\')
    if ($taskProcess.Name -ne 'node.exe' -or -not $normalizedCommand.Contains($expectedEntry)) {
        throw 'Port 3210 belongs to a process whose path cannot be verified. No process was stopped.'
    }
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $listener.OwningProcess /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('Unable to stop service process ' + $listener.OwningProcess) }
}
Write-Host 'Mock site service stopped.'
