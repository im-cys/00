param(
    [string]$DataFile = '',
    [string]$MapsFile = '',
    [string]$ModelEnv = ''
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$pythonExe = (Get-Command python.exe -ErrorAction Stop).Source
$baseUrl = 'http://127.0.0.1:3210'
$collideUrl = 'http://127.0.0.1:3311'

function Import-SelectedEnv([string]$Path, [string[]]$Names, [switch]$OnlyMissing) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
        $name = $Matches[1]
        if ($Names -notcontains $name) { continue }
        if ($OnlyMissing -and [Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
        $value = $Matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Find-FirstFile([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-Health([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 2 } catch { return $null }
}

function Assert-PortFreeOrExpected([int]$Port, [string]$HealthUrl, [string]$ExpectedApp, [string]$ExpectedSchema, [string]$ExpectedPrompt) {
    $health = Get-Health $HealthUrl
    if ($health -and $health.app -eq $ExpectedApp -and $health.answerMapSchema -eq $ExpectedSchema -and $health.promptVersion -eq $ExpectedPrompt) { return $true }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is occupied by an old or different service. Close it, then run this launcher again."
    }
    return $false
}

function Wait-ForApp([string]$HealthUrl, [string]$ExpectedApp, [string]$ExpectedSchema, [string]$ExpectedPrompt, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $health = Get-Health $HealthUrl
        if ($health -and $health.app -eq $ExpectedApp -and $health.answerMapSchema -eq $ExpectedSchema -and $health.promptVersion -eq $ExpectedPrompt) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$ExpectedApp did not become ready. Check the logs directory."
}

$projectEnv = Join-Path $projectDir '.env'
Import-SelectedEnv $projectEnv @('DATA_IMPORT_TOKEN', 'EXTRACT_API_KEY', 'EXTRACT_BASE_URL', 'EXTRACT_MODEL', 'EXTRACT_SLEEP')
if (-not $env:DATA_IMPORT_TOKEN) {
    $env:DATA_IMPORT_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
}

$resolvedData = Find-FirstFile @(
    $DataFile,
    (Join-Path $projectDir 'private-data\data.js')
)
if (-not $resolvedData) {
    throw 'Local data.js was not found. Pass -DataFile <path> or place it in private-data\data.js.'
}
$privateDataEnv = Join-Path (Split-Path -Parent $resolvedData) '.env'
$modelEnvPath = Find-FirstFile @($ModelEnv, $privateDataEnv)
if ($modelEnvPath -and $modelEnvPath -ne $projectEnv) {
    Import-SelectedEnv $modelEnvPath @('EXTRACT_API_KEY', 'EXTRACT_BASE_URL', 'EXTRACT_MODEL', 'EXTRACT_SLEEP') -OnlyMissing
}
$resolvedMaps = Find-FirstFile @(
    $MapsFile,
    (Join-Path (Split-Path -Parent $resolvedData) 'collision-maps.js')
)

# Local development is isolated from CloudBase and uses automatic demo login.
$env:CLOUDBASE_USE_DATABASE = 'false'
$env:ZHIHU_AUTH_DEMO_MODE = 'true'
$env:ZHIHU_OAUTH_APP_ID = ''
$env:ZHIHU_OAUTH_APP_KEY = ''
$env:ZHIHU_CLIENT_ID = ''
$env:ZHIHU_CLIENT_SECRET = ''
$env:ZHIHU_OAUTH_REDIRECT_URI = "$baseUrl/auth/zhihu/callback"
$env:ALLOWED_HOSTS = '127.0.0.1,localhost'
$env:HOST = '127.0.0.1'
$env:PORT = '3210'
$env:COLLIDE_HOST = '127.0.0.1'
$env:COLLIDE_BASE = $collideUrl
$env:LOCAL_OPERATION_LOG = 'runtime\operation-trace.jsonl'
$env:PYTHONUTF8 = '1'

$logsDir = Join-Path $projectDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$promptVersion = 'answer-tree-v2.6-self-contained-labels'
$pythonRunning = Assert-PortFreeOrExpected 3311 "$collideUrl/health" 'collide-service' 'answer-tree-v2' $promptVersion
if (-not $pythonRunning) {
    $pythonEntry = Join-Path $projectDir 'extractor\collide_service.py'
    Start-Process -FilePath $pythonExe -ArgumentList @($pythonEntry, '--host', '127.0.0.1', '--port', '3311') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'collide.log') -RedirectStandardError (Join-Path $logsDir 'collide-error.log') | Out-Null
    Wait-ForApp "$collideUrl/health" 'collide-service' 'answer-tree-v2' $promptVersion 60
}

$nodeRunning = Assert-PortFreeOrExpected 3210 "$baseUrl/api/health" 'answer-collision' 'answer-tree-v2' $promptVersion
if (-not $nodeRunning) {
    $nodeEntry = Join-Path $projectDir 'server\server.mjs'
    Start-Process -FilePath $nodeExe -ArgumentList @($nodeEntry) -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'service.log') -RedirectStandardError (Join-Path $logsDir 'service-error.log') | Out-Null
    Wait-ForApp "$baseUrl/api/health" 'answer-collision' 'answer-tree-v2' $promptVersion 30
}

$importArgs = @((Join-Path $projectDir 'scripts\import-private-data.mjs'), '--url', $baseUrl, '--data', $resolvedData, '--env', $projectEnv)
if ($resolvedMaps) { $importArgs += @('--maps', $resolvedMaps) }
& $nodeExe @importArgs
if ($LASTEXITCODE -ne 0) { throw 'Local data import failed.' }

Write-Host ''
Write-Host "Local site ready: $baseUrl"
Write-Host "Question page: $baseUrl/question/10006"
Write-Host 'Run npm run dev:stop when you are finished.'
if ($env:EXTRACT_API_KEY) {
    Write-Host 'Real model generation is enabled; clicking Generate will call the configured model API.'
} else {
    Write-Warning 'EXTRACT_API_KEY is missing. Page/UI testing works, but real generation will fail.'
}
