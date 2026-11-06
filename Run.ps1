param(
    [ValidateSet('balanced', 'deep')]
    [string]$Profile = 'balanced'
)

$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$logDir = Join-Path ([IO.Path]::GetTempPath()) 'LLMOptimus'
$null = New-Item -ItemType Directory -Path $logDir -Force
$server = Join-Path $appDir 'llamafile-0.10.3.exe'
$router = Join-Path $appDir 'router.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$generalModel = Join-Path $appDir 'qwen3-4b-thinking-2507.Q4_K_M.gguf'
$coderModel = Join-Path $appDir 'qwen2.5-coder-1.5b-instruct-q8_0.gguf'

foreach ($requiredFile in @($server, $generalModel, $coderModel, $router)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Missing required file: $requiredFile"
    }
}

# Close any existing servers on our ports (models and router)
# This handles the case where a previous run was interrupted or a variant is running
foreach ($port in 8080, 8081, 8082) {
    $pattern = "^\s*TCP\s+127\.0\.0\.1:$port\s+.*\s+LISTENING\s+(\d+)\s*$"
    $listener = netstat.exe -ano -p tcp | Select-String -Pattern $pattern | Select-Object -First 1
    if ($null -eq $listener) { continue }

    $processId = [int]$listener.Matches[0].Groups[1].Value
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Start-Sleep -Milliseconds 250
        continue
    }

    # Stop only processes that can be positively identified as this app. A port
    # conflict must never cause the launcher to kill unrelated software.
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    $isOurServer = $null -ne $processInfo -and $processInfo.ExecutablePath -ieq $server
    $isOurRouter = $null -ne $processInfo -and $process.Name -eq 'node' -and
        $processInfo.CommandLine -like "*$router*"
    
    if (-not $isOurServer -and -not $isOurRouter) {
        throw "Port $port is already used by an unrelated process (PID $($process.Id)). Close it or change the LLM Optimus ports; it was not stopped."
    } elseif ($isOurServer) {
        Write-Host "Stopping stale local model on port $port (PID $($process.Id))..."
    } elseif ($isOurRouter) {
        Write-Host "Stopping stale router on port $port (PID $($process.Id))..."
    }

    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$reasoningBudget = if ($Profile -eq 'deep') { 512 } else { 128 }
$predict = if ($Profile -eq 'deep') { 2048 } else { 1024 }

$coderArgs = @(
    '--server', '--model', $coderModel,
    '--host', '127.0.0.1', '--port', '8081', '--alias', 'coder',
    '--ctx-size', '8192', '--parallel', '1',
    '--threads', '8', '--threads-batch', '8',
    '--flash-attn', 'auto', '--cache-type-k', 'q8_0', '--cache-type-v', 'f16',
    '--cache-prompt', '--cache-ram', '256',
    '--jinja',
    '--reasoning', 'off', '--predict', '1024'
)

$generalArgs = @(
    '--server', '--model', $generalModel,
    '--host', '127.0.0.1', '--port', '8080', '--alias', 'general',
    '--ctx-size', '32768', '--parallel', '1',
    '--threads', '8', '--threads-batch', '8',
    '--flash-attn', 'auto', '--cache-type-k', 'q8_0', '--cache-type-v', 'f16',
    '--cache-prompt', '--cache-ram', '512',
    '--jinja',
    '--reasoning', 'auto', '--reasoning-budget', "$reasoningBudget",
    '--predict', "$predict"
)

Write-Host 'General API: http://127.0.0.1:8080/v1 (model: general)'
Write-Host 'Code API:    http://127.0.0.1:8081/v1 (model: coder)'
Write-Host 'JSON repair: internal, using the instruction-tuned coder model'
Write-Host 'Smart API:   http://127.0.0.1:8082/v1 (model: auto)'
Write-Host 'Smart Web:   http://127.0.0.1:8082/'
Write-Host "Profile:     $Profile ($reasoningBudget general reasoning tokens)"
Write-Host "Server logs: $logDir"
Write-Host 'Router activity, tool errors, and [REPAIR] diagnostics will print below.'
Write-Host 'Raw model logs remain in the server log directory shown above.'
Write-Host 'Press Ctrl+C to stop the router and both model servers.'

$coderProcess = $null
$generalProcess = $null
try {
    $coderProcess = Start-Process -FilePath $server -ArgumentList $coderArgs `
        -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'coder-server.log') `
        -RedirectStandardError (Join-Path $logDir 'coder-server-error.log')

    $deadline = (Get-Date).AddSeconds(30)
    do {
        if ($coderProcess.HasExited) {
            throw "Coding server exited during startup. Check $logDir\coder-server-error.log"
        }
        try {
            $null = Invoke-RestMethod 'http://127.0.0.1:8081/health' -TimeoutSec 2
            break
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    } while ((Get-Date) -lt $deadline)

    if ((Get-Date) -ge $deadline) {
        throw 'Coding server did not become ready within 30 seconds.'
    }

    $generalProcess = Start-Process -FilePath $server -ArgumentList $generalArgs `
        -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'general-server.log') `
        -RedirectStandardError (Join-Path $logDir 'general-server-error.log')

    $deadline = (Get-Date).AddSeconds(90)
    do {
        if ($generalProcess.HasExited) {
            throw "General server exited during startup. Check $logDir\general-server-error.log"
        }
        try {
            $null = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 2
            break
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    } while ((Get-Date) -lt $deadline)

    if ((Get-Date) -ge $deadline) {
        throw 'General server did not become ready within 90 seconds.'
    }

    & $node $router
    exit $LASTEXITCODE
}
finally {
    if ($null -ne $generalProcess -and -not $generalProcess.HasExited) {
        Stop-Process -Id $generalProcess.Id -Force
        $generalProcess.WaitForExit()
    }
    if ($null -ne $coderProcess -and -not $coderProcess.HasExited) {
        Stop-Process -Id $coderProcess.Id -Force
        $coderProcess.WaitForExit()
    }
}
