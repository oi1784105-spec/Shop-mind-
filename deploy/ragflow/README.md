# ShopMind local deployment

This deployment runs the independent ShopMind product layer on top of RAGFlow
`v0.27.0`. RAGFlow remains the document-processing, retrieval, and model
provider service. Ollama is the current local default and RAGFlow can still
connect to its other supported model providers and document engines.

RAGFlow reaches Ollama on the Windows host through:

```text
http://host.docker.internal:11434
```

The local Compose override binds all published ports to `127.0.0.1`. It also
keeps DeepDoc on CPU so Ollama can use the NVIDIA GPU.

## Validate

Run from the workspace root:

```powershell
docker compose `
  -p ecommerce-ragflow `
  --env-file vendor/ragflow/docker/.env `
  -f vendor/ragflow/docker/docker-compose.yml `
  -f deploy/ragflow/docker-compose.local.yml `
  config --quiet
```

## Start

```powershell
docker compose `
  -p ecommerce-ragflow `
  --env-file vendor/ragflow/docker/.env `
  -f vendor/ragflow/docker/docker-compose.yml `
  -f deploy/ragflow/docker-compose.local.yml `
  up -d
```

The product UI is available at `http://127.0.0.1:8080` after all health checks
pass. The RAGFlow operations UI is retained at `http://127.0.0.1:8081` and is
not part of the ShopMind product navigation.

## Required product configuration

Set these values in `vendor/ragflow/docker/.env` before using knowledge-base
operations:

```dotenv
SHOPMIND_ADMIN_USERNAME=admin
SHOPMIND_ADMIN_PASSWORD=replace-with-a-strong-password
RAGFLOW_API_KEY=ragflow-your-api-key
```

Optional model defaults can be selected from any provider already configured
inside RAGFlow:

```dotenv
RAGFLOW_DEFAULT_LLM_ID=
RAGFLOW_DEFAULT_EMBEDDING_MODEL=
```

Leaving the model values empty asks RAGFlow to use its tenant defaults. This
does not restrict the deployment to Ollama.

## Health check

```powershell
./scripts/test-shopmind.ps1
```

The check validates the product UI, product API, RAGFlow API, Redis, and the
localhost-only RAGFlow operations entry.

## Stop

```powershell
docker compose `
  -p ecommerce-ragflow `
  --env-file vendor/ragflow/docker/.env `
  -f vendor/ragflow/docker/docker-compose.yml `
  -f deploy/ragflow/docker-compose.local.yml `
  down
```

Do not add `-v` unless all local RAGFlow data should be deleted.
