# ShopMind implementation context

Updated: 2026-08-26

## Confirmed product scope

- ShopMind is a single-enterprise internal ecommerce knowledge assistant and customer-service workspace.
- The first release does not connect to real order, logistics, refund, or after-sales systems.
- The product uses account/password authentication and contains no real customer privacy or order data.
- The product UI is independent from RAGFlow, defaults to an enterprise light theme, and supports dark mode.
- The legacy RAGFlow UI remains available only as a localhost operations entry.

## Architecture constraints

- RAGFlow remains the ingestion, parsing, chunking, embedding, indexing, retrieval, reranking, and generation engine.
- ShopMind must not duplicate RAGFlow document-processing workers.
- ShopMind uses an adapter boundary so RAGFlow upgrades do not leak into product APIs.
- The existing Redis-compatible Valkey service is reused. RAGFlow uses DB 1; ShopMind uses DB 2 and `shopmind:` key prefixes.
- Redis is a cache only. Accounts, conversations, knowledge versions, publishing history, and audit data are persisted.
- Ollama is the current default provider, but ShopMind must preserve all model providers and document engines supported by RAGFlow.
- Knowledge replacement uses isolated datasets per version and an atomic active-version pointer. The current active version remains available while a draft is indexed.

## Implementation layout

- `apps/shopmind-api`: independent FastAPI product API.
- `apps/shopmind-web`: independent React/Vite product UI.
- `vendor/ragflow`: unmodified RAGFlow engine and internal operations UI.
- `deploy/ragflow/docker-compose.local.yml`: local integration and port isolation.

## Local ports

- ShopMind product: `http://127.0.0.1:8080`
- RAGFlow operations UI: `http://127.0.0.1:8081`
- RAGFlow API: `http://127.0.0.1:9380`

