[CmdletBinding()]
param(
    [string]$ProjectName = "ecommerce-ragflow"
)

$ErrorActionPreference = "Stop"

$required = @(
    "$ProjectName-shopmind-web-1",
    "$ProjectName-shopmind-api-1",
    "$ProjectName-ragflow-cpu-1",
    "$ProjectName-redis-1"
)

$containers = docker ps --format '{{.Names}}|{{.Status}}'
foreach ($name in $required) {
    $line = $containers | Where-Object { $_ -like "$name|*" }
    if (-not $line) {
        throw "Required container is not running: $name"
    }
}

$product = Invoke-WebRequest -Uri "http://127.0.0.1:8080/" -UseBasicParsing -TimeoutSec 20
if ($product.StatusCode -ne 200 -or $product.Content -notmatch "ShopMind") {
    throw "ShopMind product UI check failed"
}

$live = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/health/live" -TimeoutSec 20
if ($live.status -ne "ok") {
    throw "ShopMind API liveness check failed"
}

$ragflow = Invoke-WebRequest -Uri "http://127.0.0.1:9380/api/v1/system/healthz" -UseBasicParsing -TimeoutSec 30
if ($ragflow.StatusCode -ne 200) {
    throw "RAGFlow API health check failed"
}

$ops = Invoke-WebRequest -Uri "http://127.0.0.1:8081/" -UseBasicParsing -TimeoutSec 20
if ($ops.StatusCode -ne 200) {
    throw "RAGFlow operations UI check failed"
}

Write-Host "ShopMind product stack is healthy." -ForegroundColor Green

