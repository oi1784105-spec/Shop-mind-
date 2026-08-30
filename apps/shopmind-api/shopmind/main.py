from __future__ import annotations

import logging
import re
from html import unescape
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from .cache import CacheUnavailable, RedisSessionCache, SessionCache
from .config import Settings
from .database import Database
from .ragflow import RagflowClient, RagflowError
from .schemas import (
    ConversationCreate,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentUpdate,
    KnowledgeVersionUpdate,
    LoginRequest,
    MessageCreate,
    RagflowApiKeyUpdate,
    RagflowSyncRequest,
)
from .security import new_token, verify_password


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("shopmind")
COOKIE_NAME = "shopmind_session"
ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx", ".html", ".htm", ".md", ".txt", ".csv", ".xls", ".xlsx"}
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
SYNC_RESOURCE_TYPES = {"providers", "models", "datasets", "documents", "chats", "memories"}
SENSITIVE_FIELD_NAMES = {
    "api_key",
    "apikey",
    "secret",
    "password",
    "credential",
    "authorization",
    "access_token",
    "refresh_token",
    "token",
}


def redact_remote_value(value: Any) -> Any:
    """Remove credentials from provider/model payloads before returning them to the UI."""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized = key.lower().replace("-", "_")
            if normalized in SENSITIVE_FIELD_NAMES or normalized.endswith("_secret") or normalized.endswith("_api_key"):
                continue
            result[key] = redact_remote_value(item)
        return result
    if isinstance(value, list):
        return [redact_remote_value(item) for item in value]
    return value


def normalize_answer(value: Any) -> str:
    """Convert model Markdown/table output into readable plain text."""
    if not isinstance(value, str):
        return ""
    text = unescape(value).replace("\r\n", "\n").replace("\r", "\n").replace("；", "\n").replace(";", "\n")
    text = re.sub(r"```(?:[\w+-]+)?\s*", "", text).replace("```", "")
    lines: list[str] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if "|" in line:
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if len(cells) > 1 and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                continue
            if len(cells) > 1:
                for cell in cells:
                    cell = re.sub(r"(\*\*|__|~~|`)", "", cell)
                    cell = re.sub(r"\s+", " ", cell).strip()
                    if cell:
                        lines.append(cell)
                continue
        if re.fullmatch(r"[-_*]{3,}", line):
            continue
        line = re.sub(r"^#{1,6}\s*", "", line)
        line = re.sub(r"^[-*+]\s+", "", line)
        line = re.sub(r"^\d+[.)]\s+", "", line)
        line = re.sub(r"(\*\*|__|~~|`)", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def completion_answer(completion: dict[str, Any]) -> str:
    answer = completion.get("answer") or completion.get("response") or completion.get("content") or ""
    if isinstance(answer, dict):
        answer = answer.get("answer") or answer.get("content") or ""
    return normalize_answer(answer)


def _question_terms(value: str) -> set[str]:
    """Extract compact terms for safe FAQ matching without another model call."""
    if not isinstance(value, str):
        return set()
    lowered = value.lower()
    terms = set(re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9][A-Za-z0-9._:-]*", lowered))
    cjk = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    # Chinese FAQ wording often differs slightly (例如“哪一天”与“哪天”).
    # Character bigrams provide a stable, model-free overlap signal.
    terms.update(cjk[index : index + 2] for index in range(max(0, len(cjk) - 1)))
    stop_words = {"请问", "请直接", "请给出", "一下", "是否", "可以", "怎么", "如何", "规则", "说明", "一下"}
    return {term for term in terms if term not in stop_words}


def _answer_needs_recovery(answer: str, question: str) -> bool:
    """Detect empty, echoed, truncated, or repetitive local-model output."""
    if not answer or len(answer.strip()) < 8:
        return True
    lowered = answer.lower()
    if "模型未返回" in answer or "上下文窗口" in answer or "context window" in lowered:
        return True
    if re.search(r"(.{1,8})\1{2,}", answer) or answer.count("从") >= 3 or answer.count("，从") >= 2:
        return True
    q_terms = _question_terms(question)
    a_terms = _question_terms(answer)
    q_compact = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", question.lower())
    a_compact = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", answer.lower())
    if q_compact and a_compact.startswith(q_compact[:6]) and len(a_compact) <= len(q_compact) + 40:
        return True
    # Guard against a fluent but semantically wrong answer when the question
    # asks for a temporal, shipping-cost, or unboxing rule.
    if any(marker in question for marker in ("时间", "哪天", "哪一天", "几天", "多久", "何时")) and not any(
        marker in answer for marker in ("签收", "第", "日", "天", "小时", "工作日")
    ):
        return True
    if "运费" in question and "运费" not in answer:
        return True
    if "拆封" in question and "拆封" not in answer:
        return True
    if q_terms and len(q_terms) >= 2 and len(q_terms & a_terms) / len(q_terms) >= 0.75:
        # A short answer made almost entirely from the question is an echo.
        if len(answer) <= len(question) + 24:
            return True
    return False


def recover_answer_from_references(question: str, references: list[dict[str, Any]]) -> str:
    """Recover a concise answer from a retrieved FAQ/rule chunk when generation is unusable."""
    q_terms = _question_terms(question)
    if not q_terms:
        return ""
    best: tuple[int, str] | None = None
    for reference in references:
        content = reference.get("content") if isinstance(reference, dict) else ""
        if not isinstance(content, str):
            continue
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line or "|" not in line:
                continue
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if len(cells) < 2 or all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                continue
            score = len(q_terms & _question_terms(cells[0]))
            if any(marker in question for marker in ("时间", "哪天", "哪一天", "几天", "多久", "何时")) and any(
                marker in cells[0] for marker in ("时间", "哪天", "哪一天", "算起", "签收")
            ):
                score += 10
            if "运费" in question and "运费" in cells[0]:
                score += 10
            if "拆封" in question and "拆封" in cells[0]:
                score += 10
            if score < 1:
                continue
            answer = normalize_answer(cells[1])
            if not answer:
                continue
            # Prefer a direct FAQ match, then the answer with the greatest overlap.
            exact_bonus = 3 if score >= 2 else 0
            candidate = (score + exact_bonus, answer)
            if best is None or candidate[0] > best[0]:
                best = candidate
    if best:
        return best[1]

    # Fall back to short rule lines containing multiple question terms.
    candidates: list[tuple[int, str]] = []
    for reference in references:
        content = reference.get("content") if isinstance(reference, dict) else ""
        if not isinstance(content, str):
            continue
        for raw_line in content.splitlines():
            line = normalize_answer(raw_line)
            if not line or len(line) > 180:
                continue
            score = len(q_terms & _question_terms(line))
            if score >= 2:
                candidates.append((score, line))
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return "\n".join(line for _, line in candidates[:3])
    return ""


def mask_api_key(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 10:
        return "已配置"
    return f"{value[:7]}••••{value[-4:]}"


def persist_ragflow_api_key(env_file: str, api_key: str) -> None:
    """Update only RAGFLOW_API_KEY in the configured local compose env file."""
    path = Path(env_file)
    if not path.exists():
        raise FileNotFoundError(f"RAGFlow env file not found: {path}")
    content = path.read_text(encoding="utf-8")
    replacement = f"RAGFLOW_API_KEY={api_key}"
    pattern = re.compile(r"(?m)^RAGFLOW_API_KEY=.*$")
    if pattern.search(content):
        updated = pattern.sub(replacement, content, count=1)
    else:
        suffix = "" if not content or content.endswith("\n") else "\n"
        updated = f"{content}{suffix}{replacement}\n"
    path.write_text(updated, encoding="utf-8")


def create_app(
    settings: Settings | None = None,
    database: Database | None = None,
    cache: SessionCache | None = None,
    ragflow: RagflowClient | None = None,
) -> FastAPI:
    config = settings or Settings()
    db = database or Database(config.database_path)
    session_cache = cache or RedisSessionCache(config.redis_url)
    ragflow_client = ragflow or RagflowClient(
        config.ragflow_base_url,
        config.ragflow_api_key,
        timeout=config.ragflow_request_timeout_seconds,
        internal_proxy=config.ragflow_internal_proxy,
        tenant_id=config.ragflow_tenant_id,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        db.initialize(config.admin_username, config.admin_password)
        logger.info("ShopMind API initialized")
        yield

    app = FastAPI(title="ShopMind Product API", version="0.1.0", lifespan=lifespan)
    app.state.settings = config
    app.state.db = db
    app.state.cache = session_cache
    app.state.ragflow = ragflow_client
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RagflowError)
    async def ragflow_error_handler(_: Request, exc: RagflowError):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc), "code": "RAGFLOW_ERROR"})

    @app.exception_handler(CacheUnavailable)
    async def cache_error_handler(_: Request, exc: CacheUnavailable):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content={"detail": str(exc), "code": "CACHE_UNAVAILABLE"})

    def current_user(session_token: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> dict[str, Any]:
        if not session_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        session = session_cache.get_json(f"session:{session_token}")
        if not session:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
        user = db.get_user(session["user_id"])
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        session_cache.set_json(f"session:{session_token}", session, config.session_ttl_seconds)
        return user

    def admin_user(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if user.get("role") != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        return user

    @app.get("/api/v1/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/health")
    async def health(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        redis_ok = False
        try:
            redis_ok = session_cache.ping()
        except CacheUnavailable:
            pass
        ragflow_health = await ragflow_client.health()
        return {
            "status": "ok" if redis_ok and ragflow_health["reachable"] else "degraded",
            "redis": "ok" if redis_ok else "unavailable",
            "ragflow": ragflow_health,
            "ragflow_configured": ragflow_client.configured,
            "ops_url": config.ragflow_ops_url,
            "model_policy": "RAGFlow-managed; Ollama is the current default and other providers remain supported",
        }

    @app.post("/api/v1/auth/login")
    async def login(payload: LoginRequest, response: Response) -> dict[str, Any]:
        user = db.get_user_by_username(payload.username)
        if not user or not verify_password(payload.password, user["password_hash"]):
            db.audit(user["id"] if user else None, "auth.login_failed", "user", user["id"] if user else None)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
        token = new_token()
        session_cache.set_json(f"session:{token}", {"user_id": user["id"]}, config.session_ttl_seconds)
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=config.session_ttl_seconds,
            httponly=True,
            secure=config.cookie_secure,
            samesite="lax",
            path="/",
        )
        db.audit(user["id"], "auth.login", "user", user["id"])
        return {"user": {key: user[key] for key in ("id", "username", "display_name", "role")}}

    @app.post("/api/v1/auth/logout")
    async def logout(response: Response, session_token: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> dict[str, bool]:
        if session_token:
            session_cache.delete(f"session:{session_token}")
        response.delete_cookie(COOKIE_NAME, path="/")
        return {"success": True}

    @app.get("/api/v1/auth/me")
    async def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        return {"user": {key: user[key] for key in ("id", "username", "display_name", "role")}}

    @app.get("/api/v1/dashboard")
    async def dashboard(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        return {"metrics": db.dashboard(), "knowledge_bases": db.list_knowledge_bases()[:5]}

    @app.get("/api/v1/knowledge-bases")
    async def list_knowledge_bases(_: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        return {"items": db.list_knowledge_bases()}

    @app.get("/api/v1/admin/ragflow/providers")
    async def ragflow_providers(_: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        providers = await ragflow_client.list_providers()
        models = await ragflow_client.list_models()
        defaults = await ragflow_client.list_default_models()
        return {
            "providers": [redact_remote_value(item) for item in providers],
            "models": [redact_remote_value(item) for item in models],
            "default_models": [redact_remote_value(item) for item in defaults],
        }

    @app.get("/api/v1/admin/ragflow/config-status")
    async def ragflow_config_status(_: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        health_result = await ragflow_client.health()
        model_count = 0
        provider_count = 0
        detail = ""
        if ragflow_client.configured and health_result.get("reachable"):
            try:
                providers = await ragflow_client.list_providers()
                models = await ragflow_client.list_models()
                provider_count = len(providers)
                model_count = len(models)
            except RagflowError as exc:
                detail = str(exc)
        return {
            "configured": ragflow_client.configured,
            "reachable": bool(health_result.get("reachable")),
            "provider_count": provider_count,
            "model_count": model_count,
            "detail": detail,
            "model_policy": "RAGFlow-managed; all configured providers remain supported",
        }

    @app.get("/api/v1/admin/ragflow/config")
    async def get_ragflow_config(_: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        api_key = getattr(ragflow_client, "api_key", "") or ""
        return {
            "configured": bool(api_key),
            "masked_key": mask_api_key(api_key),
            "env_file_available": Path(config.ragflow_env_file).exists(),
        }

    @app.put("/api/v1/admin/ragflow/config")
    async def update_ragflow_config(payload: RagflowApiKeyUpdate, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        api_key = payload.api_key.strip()
        if not api_key.lower().startswith("ragflow") or any(char in api_key for char in "\r\n\t"):
            raise HTTPException(status_code=422, detail="RAGFlow API Key 必须以 RAGFlow 开头，且不能包含空白换行")
        try:
            persist_ragflow_api_key(config.ragflow_env_file, api_key)
        except FileNotFoundError as exc:
            logger.error("RAGFlow env file is unavailable: %s", exc)
            raise HTTPException(status_code=503, detail="找不到 RAGFlow 环境配置文件，请检查部署挂载") from exc
        except OSError as exc:
            logger.error("Failed to persist RAGFlow API key: %s", exc)
            raise HTTPException(status_code=500, detail="RAGFlow API Key 保存失败，请检查配置文件写入权限") from exc
        ragflow_client.api_key = api_key
        db.audit(user["id"], "ragflow.api_key_updated", "ragflow_config", "api_key", {"configured": True})
        logger.info("RAGFlow API Key updated in memory and persisted without logging secret value")
        return {"configured": True, "masked_key": mask_api_key(api_key), "persisted": True, "requires_restart": False}

    @app.post("/api/v1/admin/ragflow/sync", status_code=202)
    async def trigger_ragflow_sync(payload: RagflowSyncRequest, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        resource_types = sorted(set(payload.resource_types))
        invalid = [item for item in resource_types if item not in SYNC_RESOURCE_TYPES]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Unsupported resource types: {', '.join(invalid)}")
        job = db.create_sync_job("ragflow", payload.scope, resource_types, created_by=user["id"])
        db.audit(user["id"], "sync.request", "sync_job", job["id"], {"scope": payload.scope, "resource_types": resource_types})
        return {"job_id": job["id"], "status": job["status"], "resource_types": resource_types}

    @app.get("/api/v1/admin/sync/jobs/{job_id}")
    async def get_sync_job(job_id: str, _: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        job = db.get_sync_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Sync job not found")
        return job

    @app.get("/api/v1/knowledge-bases/{kb_id}/external-resources")
    async def list_knowledge_external_resources(kb_id: str, _: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if not db.get_knowledge_base(kb_id):
            raise HTTPException(status_code=404, detail="Knowledge base not found")
        return {"items": db.list_external_resources(local_resource_id=kb_id)}

    @app.post("/api/v1/knowledge-bases/{kb_id}/sync", status_code=202)
    async def trigger_knowledge_base_sync(kb_id: str, user: dict[str, Any] = Depends(admin_user)) -> dict[str, Any]:
        if not db.get_knowledge_base(kb_id):
            raise HTTPException(status_code=404, detail="Knowledge base not found")
        job = db.create_sync_job("ragflow", f"knowledge_base:{kb_id}", ["datasets", "documents", "chats"], created_by=user["id"])
        db.audit(user["id"], "sync.knowledge_base_request", "knowledge_base", kb_id, {"job_id": job["id"]})
        return {"job_id": job["id"], "status": job["status"], "scope": job["scope"]}

    @app.post("/api/v1/knowledge-bases", status_code=201)
    async def create_knowledge_base(payload: KnowledgeBaseCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        dataset = await ragflow_client.create_dataset(
            f"ShopMind-{payload.name}-v1", payload.description, config.ragflow_default_embedding_model
        )
        item = db.create_knowledge_base(payload.name, payload.description, user["id"], dataset["id"])
        db.audit(user["id"], "knowledge.create", "knowledge_base", item["id"])
        return item

    @app.patch("/api/v1/knowledge-bases/{kb_id}")
    async def update_knowledge_base(kb_id: str, payload: KnowledgeBaseUpdate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        kb = db.get_knowledge_base(kb_id)
        if not kb:
            raise HTTPException(404, "Knowledge base not found")
        versions = db.list_versions(kb_id)
        # Keep the remote dataset names aligned with the product metadata.
        for version in versions:
            await ragflow_client.update_dataset(
                version["ragflow_dataset_id"],
                f"ShopMind-{payload.name}-v{version['version_number']}",
                payload.description,
            )
        item = db.update_knowledge_base(kb_id, payload.name, payload.description)
        db.audit(user["id"], "knowledge.update", "knowledge_base", kb_id, {"name": payload.name})
        return item or {}

    @app.delete("/api/v1/knowledge-bases/{kb_id}")
    async def delete_knowledge_base(kb_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
        kb = db.get_knowledge_base(kb_id)
        if not kb:
            raise HTTPException(404, "Knowledge base not found")
        versions = db.list_versions(kb_id)
        for version in versions:
            await ragflow_client.delete_dataset(version["ragflow_dataset_id"])
            if version.get("ragflow_chat_id"):
                try:
                    await ragflow_client.delete_chat(version["ragflow_chat_id"])
                except RagflowError as exc:
                    logger.warning("Failed to delete RAGFlow chat %s during knowledge-base deletion: %s", version["ragflow_chat_id"], exc)
        db.delete_knowledge_base(kb_id)
        session_cache.delete(f"kb-active:{kb_id}")
        db.audit(user["id"], "knowledge.delete", "knowledge_base", kb_id)
        return {"success": True}

    @app.get("/api/v1/knowledge-bases/{kb_id}/versions")
    async def list_versions(kb_id: str, _: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if not db.get_knowledge_base(kb_id):
            raise HTTPException(404, "Knowledge base not found")
        return {"items": db.list_versions(kb_id)}

    @app.post("/api/v1/knowledge-bases/{kb_id}/versions", status_code=201)
    async def create_version(kb_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        kb = db.get_knowledge_base(kb_id)
        if not kb:
            raise HTTPException(404, "Knowledge base not found")
        versions = db.list_versions(kb_id)
        next_number = max((int(version.get("version_number") or 0) for version in versions), default=0) + 1
        dataset = await ragflow_client.create_dataset(
            f"ShopMind-{kb['name']}-v{next_number}", kb["description"], config.ragflow_default_embedding_model
        )
        version = db.create_version(kb_id, user["id"], dataset["id"])
        db.audit(user["id"], "knowledge.version_create", "knowledge_version", version["id"])
        return version

    @app.patch("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}")
    async def update_version(
        kb_id: str, version_id: str, payload: KnowledgeVersionUpdate, user: dict[str, Any] = Depends(current_user)
    ) -> dict[str, Any]:
        version = db.get_version(version_id)
        if not version or version["knowledge_base_id"] != kb_id:
            raise HTTPException(404, "Knowledge version not found")
        if version["status"] == "active":
            raise HTTPException(409, "The active version cannot be renamed")
        item = db.update_version(version_id, payload.name)
        db.audit(user["id"], "knowledge.version_update", "knowledge_version", version_id, {"name": payload.name})
        return item or {}

    @app.delete("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}")
    async def delete_version(kb_id: str, version_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
        version = db.get_version(version_id)
        if not version or version["knowledge_base_id"] != kb_id:
            raise HTTPException(404, "Knowledge version not found")
        if version["status"] == "active":
            raise HTTPException(409, "The active version cannot be deleted")
        await ragflow_client.delete_dataset(version["ragflow_dataset_id"])
        if version.get("ragflow_chat_id"):
            try:
                await ragflow_client.delete_chat(version["ragflow_chat_id"])
            except RagflowError as exc:
                logger.warning("Failed to delete RAGFlow chat %s during version deletion: %s", version["ragflow_chat_id"], exc)
        db.delete_version(version_id)
        db.audit(user["id"], "knowledge.version_delete", "knowledge_version", version_id)
        return {"success": True}

    @app.get("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents")
    async def list_documents(kb_id: str, version_id: str, _: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        version = db.get_version(version_id)
        if not version or version["knowledge_base_id"] != kb_id:
            raise HTTPException(404, "Knowledge version not found")
        remote_documents = await ragflow_client.list_documents(version["ragflow_dataset_id"])
        for document in remote_documents:
            db.update_document_status(
                document["id"], str(document.get("run", "UNSTART")), float(document.get("progress", 0)), str(document.get("progress_msg", ""))
            )
        return {"items": db.list_documents(version_id)}

    @app.post("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents", status_code=201)
    async def upload_document(
        kb_id: str,
        version_id: str,
        file: UploadFile = File(...),
        user: dict[str, Any] = Depends(current_user),
    ) -> dict[str, Any]:
        version = db.get_version(version_id)
        if not version or version["knowledge_base_id"] != kb_id:
            raise HTTPException(404, "Knowledge version not found")
        if version["status"] not in {"draft", "failed"}:
            raise HTTPException(409, "Only draft versions accept documents")
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            raise HTTPException(400, f"Unsupported file type: {suffix or 'unknown'}")
        content = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "File exceeds the 64 MB limit")
        uploaded = await ragflow_client.upload_document(
            version["ragflow_dataset_id"], file.filename or "document", content, file.content_type or "application/octet-stream"
        )
        document_ids = []
        items = []
        for document in uploaded:
            document_ids.append(document["id"])
            items.append(db.add_document(version_id, document["id"], document.get("name", file.filename), int(document.get("size", len(content))), document.get("run", "UNSTART")))
        await ragflow_client.parse_documents(version["ragflow_dataset_id"], document_ids)
        db.audit(user["id"], "knowledge.document_upload", "knowledge_version", version_id, {"files": [item["name"] for item in items]})
        return {"items": items}

    @app.patch("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents/{document_id}")
    async def update_document(
        kb_id: str,
        version_id: str,
        document_id: str,
        payload: KnowledgeDocumentUpdate,
        user: dict[str, Any] = Depends(current_user),
    ) -> dict[str, Any]:
        version = db.get_version(version_id)
        document = db.get_document(document_id)
        if not version or version["knowledge_base_id"] != kb_id or not document or document["version_id"] != version_id:
            raise HTTPException(404, "Knowledge document not found")
        if version["status"] == "active":
            raise HTTPException(409, "Documents in the active version cannot be modified")
        await ragflow_client.update_document(version["ragflow_dataset_id"], document["ragflow_document_id"], payload.name)
        item = db.update_document_name(document_id, payload.name)
        db.audit(user["id"], "knowledge.document_update", "document", document_id, {"name": payload.name})
        return item or {}

    @app.delete("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents/{document_id}")
    async def delete_document(
        kb_id: str, version_id: str, document_id: str, user: dict[str, Any] = Depends(current_user)
    ) -> dict[str, bool]:
        version = db.get_version(version_id)
        document = db.get_document(document_id)
        if not version or version["knowledge_base_id"] != kb_id or not document or document["version_id"] != version_id:
            raise HTTPException(404, "Knowledge document not found")
        if version["status"] == "active":
            raise HTTPException(409, "Documents in the active version cannot be deleted")
        await ragflow_client.delete_documents(version["ragflow_dataset_id"], [document["ragflow_document_id"]])
        db.delete_document(document_id)
        db.audit(user["id"], "knowledge.document_delete", "document", document_id)
        return {"success": True}

    @app.post("/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/publish")
    async def publish_version(kb_id: str, version_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        version = db.get_version(version_id)
        if not version or version["knowledge_base_id"] != kb_id:
            raise HTTPException(404, "Knowledge version not found")
        if version["status"] not in {"draft", "failed"}:
            raise HTTPException(409, "Only draft or failed versions can be published")
        remote_documents = await ragflow_client.list_documents(version["ragflow_dataset_id"])
        if not remote_documents:
            raise HTTPException(409, "At least one document is required before publishing")
        incomplete = [document for document in remote_documents if str(document.get("run")) not in {"3", "DONE"}]
        if incomplete:
            raise HTTPException(409, "All documents must finish processing before publishing")
        kb = db.get_knowledge_base(kb_id)
        chat = await ragflow_client.create_chat(
            f"ShopMind-{kb['name']}-v{version['version_number']}", version["ragflow_dataset_id"], config.ragflow_default_llm_id
        )
        activated = db.activate_version(kb_id, version_id, chat["id"])
        session_cache.delete(f"kb-active:{kb_id}")
        db.audit(user["id"], "knowledge.publish", "knowledge_version", version_id)
        return activated

    @app.get("/api/v1/conversations")
    async def list_conversations(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        return {"items": db.list_conversations(user["id"])}

    @app.post("/api/v1/conversations", status_code=201)
    async def create_conversation(payload: ConversationCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        requested_ids = list(dict.fromkeys(payload.knowledge_base_ids or ([] if not payload.knowledge_base_id else [payload.knowledge_base_id])))
        if not requested_ids:
            raise HTTPException(422, "请选择至少一个已发布知识库")
        active_versions = [db.get_active_version(kb_id) for kb_id in requested_ids]
        if any(version is None for version in active_versions):
            raise HTTPException(409, "所选知识库均需先发布可用版本")
        conversation = db.create_conversation(user["id"], requested_ids, payload.title)
        db.audit(user["id"], "conversation.create", "conversation", conversation["id"])
        return conversation

    @app.delete("/api/v1/conversations/{conversation_id}")
    async def delete_conversation(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
        conversation = db.get_conversation(conversation_id)
        if not conversation or conversation["user_id"] != user["id"]:
            raise HTTPException(404, "Conversation not found")
        db.delete_conversation(conversation_id)
        session_cache.delete(f"conversation:{conversation_id}")
        db.audit(user["id"], "conversation.delete", "conversation", conversation_id)
        return {"success": True}

    @app.get("/api/v1/conversations/{conversation_id}/messages")
    async def list_messages(conversation_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        conversation = db.get_conversation(conversation_id)
        if not conversation or conversation["user_id"] != user["id"]:
            raise HTTPException(404, "Conversation not found")
        return {"items": db.list_messages(conversation_id)}

    @app.post("/api/v1/conversations/{conversation_id}/messages", status_code=201)
    async def create_message(conversation_id: str, payload: MessageCreate, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        conversation = db.get_conversation(conversation_id)
        if not conversation or conversation["user_id"] != user["id"]:
            raise HTTPException(404, "Conversation not found")
        kb_ids = db.conversation_knowledge_base_ids(conversation)
        active_versions = [db.get_active_version(kb_id) for kb_id in kb_ids]
        if any(version is None for version in active_versions):
            raise HTTPException(409, "所选知识库均需先发布可用版本")
        active_version = active_versions[0]
        version_ids = [version["id"] for version in active_versions]
        bound_version_ids = db.conversation_knowledge_version_ids(conversation)
        if bound_version_ids != version_ids or not conversation["ragflow_session_id"]:
            if len(active_versions) == 1 and active_version["ragflow_chat_id"]:
                chat_id = active_version["ragflow_chat_id"]
            else:
                chat = await ragflow_client.create_chat(
                    f"ShopMind-{conversation['title']}",
                    [version["ragflow_dataset_id"] for version in active_versions],
                    config.ragflow_default_llm_id,
                )
                chat_id = chat["id"]
            remote_session = await ragflow_client.create_session(
                chat_id, conversation["title"], user["id"]
            )
            db.bind_conversation(conversation_id, active_version["id"], chat_id, remote_session["id"], version_ids)
            conversation = db.get_conversation(conversation_id) or conversation
        user_message = db.add_message(conversation_id, "user", payload.content)
        history = db.list_messages(conversation_id, 24)
        model_messages = [{"role": item["role"], "content": item["content"]} for item in history]
        try:
            completion = await ragflow_client.complete(
                conversation["ragflow_chat_id"], conversation["ragflow_session_id"], model_messages
            )
        except Exception:
            # Do not leave a normal-looking user message behind when the
            # upstream model call failed. The client can safely retry it.
            db.delete_message(user_message["id"])
            raise
        reference = completion.get("reference") or {}
        references = reference.get("chunks", []) if isinstance(reference, dict) else []
        answer = completion_answer(completion)
        if _answer_needs_recovery(answer, payload.content) and references:
            recovered = recover_answer_from_references(payload.content, references)
            if recovered:
                logger.warning("Model answer quality was below threshold; recovered answer from %d references", len(references))
                answer = recovered
        if not answer and references:
            answer = "已检索到相关企业规则，但模型未返回完整答复，请查看下方回答依据。"
        assistant_message = db.add_message(conversation_id, "assistant", answer, references)
        session_cache.set_json(
            f"conversation:{conversation_id}",
            [{"role": item["role"], "content": item["content"]} for item in db.list_messages(conversation_id, 24)],
            config.conversation_cache_ttl_seconds,
        )
        return {"user_message": user_message, "assistant_message": assistant_message, "knowledge_version": active_version["version_number"]}

    return app


app = create_app()
