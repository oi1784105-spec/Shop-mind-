from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_name: str = "ShopMind"
    database_path: str = os.getenv("SHOPMIND_DATABASE_PATH", "/data/shopmind.db")
    redis_url: str = os.getenv("SHOPMIND_REDIS_URL", "redis://redis:6379/2")
    session_ttl_seconds: int = int(os.getenv("SHOPMIND_SESSION_TTL_SECONDS", "1800"))
    conversation_cache_ttl_seconds: int = int(os.getenv("SHOPMIND_CONVERSATION_CACHE_TTL_SECONDS", "7200"))
    cookie_secure: bool = _bool("SHOPMIND_COOKIE_SECURE")
    admin_username: str = os.getenv("SHOPMIND_ADMIN_USERNAME", "admin")
    # Credentials must be supplied by the deployment environment.  Keeping an
    # empty fallback prevents publishing or accidentally running with a known
    # administrator password.
    admin_password: str = os.getenv("SHOPMIND_ADMIN_PASSWORD", "")
    ragflow_base_url: str = os.getenv("RAGFLOW_BASE_URL", "http://ragflow-cpu:9380")
    ragflow_api_key: str = os.getenv("RAGFLOW_API_KEY", "")
    # ShopMind talks to the bundled RAGFlow Nginx proxy inside the Docker
    # network.  This lets the local operations-auth bridge authenticate the
    # product service without weakening the public 9380 API authentication.
    ragflow_internal_proxy: bool = _bool("RAGFLOW_INTERNAL_PROXY")
    ragflow_tenant_id: str = os.getenv("RAGFLOW_SHOPMIND_TENANT_ID", "")
    ragflow_request_timeout_seconds: float = float(os.getenv("RAGFLOW_REQUEST_TIMEOUT_SECONDS", "180"))
    ragflow_env_file: str = os.getenv("SHOPMIND_RAGFLOW_ENV_FILE", "/config/ragflow.env")
    ragflow_default_llm_id: str = os.getenv("RAGFLOW_DEFAULT_LLM_ID", "")
    ragflow_default_embedding_model: str = os.getenv("RAGFLOW_DEFAULT_EMBEDDING_MODEL", "")
    ragflow_ops_url: str = os.getenv("RAGFLOW_OPS_URL", "http://127.0.0.1:8081")
    cors_origins: tuple[str, ...] = tuple(
        item.strip()
        for item in os.getenv("SHOPMIND_CORS_ORIGINS", "http://127.0.0.1:8080,http://localhost:8080").split(",")
        if item.strip()
    )
