$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot

function Stop-VerifiedService([int]$Port, [string]$ExpectedEntry) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return 0 }
    $expected = [IO.Path]::GetFullPath((Join-Path $projectDir $ExpectedEntry)).Replace('/', '\')
    $stopped = 0
    foreach ($listener in $listeners) {
        $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess)
        $commandLine = [string]$taskProcess.CommandLine
        $commandLine = $commandLine.Replace('/', '\')
        if ($commandLine.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "Port $Port belongs to a process outside this project. Nothing was stopped."
        }
        Stop-Process -Id $listener.OwningProcess -Force
        $stopped++
    }
    return $stopped
}

$count = 0
$count += Stop-VerifiedService 3210 'server\server.mjs'
$count += Stop-VerifiedService 3311 'extractor\collide_service.py'
if ($count) { Write-Host "Stopped $count local development service(s)." }
else { Write-Host 'Local development services are not running.' }
