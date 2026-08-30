$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path $PSScriptRoot -Parent
$expectedServices = @("es01", "minio", "mysql", "ragflow-cpu", "redis")

Push-Location $workspaceRoot
try {
    $composeArgs = @(
        "compose",
        "-p", "ecommerce-ragflow",
        "--env-file", "vendor/ragflow/docker/.env",
        "-f", "vendor/ragflow/docker/docker-compose.yml",
        "-f", "deploy/ragflow/docker-compose.local.yml"
    )

    $runningServices = @(& docker @composeArgs ps --status running --services)
    foreach ($service in $expectedServices) {
        if ($service -notin $runningServices) {
            throw "RAGFlow service is not running: $service"
        }
    }

    $health = Invoke-RestMethod `
        -Method Get `
        -TimeoutSec 10 `
        -Uri "http://127.0.0.1:9380/api/v1/system/healthz"

    foreach ($property in @("status", "db", "doc_engine", "redis", "storage")) {
        if ($health.$property -ne "ok") {
            throw "RAGFlow health check failed: $property=$($health.$property)"
        }
    }

    $ui = Invoke-WebRequest `
        -UseBasicParsing `
        -TimeoutSec 10 `
        -Uri "http://127.0.0.1:8080/"

    if ($ui.StatusCode -ne 200) {
        throw "RAGFlow UI returned HTTP $($ui.StatusCode)"
    }

    [pscustomobject]@{
        Status   = "ok"
        Services = $runningServices.Count
        UI       = $ui.StatusCode
        API      = 200
    }
}
finally {
    Pop-Location
}
