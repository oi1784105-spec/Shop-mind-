from __future__ import annotations

from typing import Any

import httpx


class RagflowError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class RagflowClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 180.0,
        internal_proxy: bool = False,
        tenant_id: str = "",
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.internal_proxy = internal_proxy
        self.tenant_id = tenant_id.strip()

    @property
    def configured(self) -> bool:
        return bool(self.base_url and (self.api_key or (self.internal_proxy and self.tenant_id)))

    def _headers(self) -> dict[str, str]:
        if self.internal_proxy and self.tenant_id:
            return {"X-ShopMind-Tenant-ID": self.tenant_id}
        if not self.api_key:
            raise RagflowError("RAGFlow API key has not been configured", 503)
        return {"Authorization": f"Bearer {self.api_key}"}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {**self._headers(), **kwargs.pop("headers", {})}
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
                response = await client.request(method, path, headers=headers, **kwargs)
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException as exc:
            raise RagflowError("本地模型响应超时，请稍后重试或检查 Ollama 运行负载", 504) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise RagflowError(f"RAGFlow request failed: {exc}") from exc
        if isinstance(payload, dict) and payload.get("code", 0) != 0:
            raise RagflowError(payload.get("message") or "RAGFlow returned an error")
        return payload.get("data", payload) if isinstance(payload, dict) else payload

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=5) as client:
                response = await client.get("/api/v1/system/healthz")
            return {"reachable": response.status_code == 200, "detail": response.json()}
        except (httpx.HTTPError, ValueError):
            return {"reachable": False, "detail": {}}

    @staticmethod
    def _as_list(data: Any, *keys: str) -> list[dict[str, Any]]:
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            for key in keys:
                value = data.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
            for value in data.values():
                if isinstance(value, list) and all(isinstance(item, dict) for item in value):
                    return value
        return []

    async def list_providers(self, *, available: bool = False) -> list[dict[str, Any]]:
        params = {"available": "true"} if available else {}
        data = await self._request("GET", "/api/v1/providers", params=params)
        return self._as_list(data, "providers", "items")

    async def list_models(self, model_type: str | None = None) -> list[dict[str, Any]]:
        params = {"type": model_type} if model_type else {}
        data = await self._request("GET", "/api/v1/models", params=params)
        return self._as_list(data, "models", "items")

    async def list_default_models(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/v1/models/default")
        return self._as_list(data, "models", "items")

    async def list_datasets(self, *, page: int = 1, page_size: int = 100) -> list[dict[str, Any]]:
        data = await self._request(
            "GET", "/api/v1/datasets", params={"page": page, "page_size": page_size, "orderby": "create_time", "desc": True}
        )
        return self._as_list(data, "datasets", "items")

    async def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        data = await self._request("GET", f"/api/v1/datasets/{dataset_id}")
        return data if isinstance(data, dict) else {}

    async def list_chats(self, *, page: int = 1, page_size: int = 100) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/v1/chats", params={"page": page, "page_size": page_size})
        return self._as_list(data, "chats", "items")

    async def get_chat(self, chat_id: str) -> dict[str, Any]:
        data = await self._request("GET", f"/api/v1/chats/{chat_id}")
        return data if isinstance(data, dict) else {}

    async def delete_chat(self, chat_id: str) -> None:
        await self._request("DELETE", f"/api/v1/chats/{chat_id}")

    async def list_memories(self, *, page: int = 1, page_size: int = 100) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/v1/memories", params={"page": page, "page_size": page_size})
        return self._as_list(data, "memories", "items")

    async def delete_dataset(self, dataset_id: str) -> None:
        await self._request("DELETE", "/api/v1/datasets", json={"ids": [dataset_id]})

    async def delete_documents(self, dataset_id: str, document_ids: list[str]) -> None:
        await self._request("DELETE", f"/api/v1/datasets/{dataset_id}/documents", json={"ids": document_ids})

    async def update_dataset(self, dataset_id: str, name: str, description: str) -> dict[str, Any]:
        data = await self._request("PUT", f"/api/v1/datasets/{dataset_id}", json={"name": name, "description": description})
        return data if isinstance(data, dict) else {}

    async def update_document(self, dataset_id: str, document_id: str, name: str) -> dict[str, Any]:
        data = await self._request("PATCH", f"/api/v1/datasets/{dataset_id}/documents/{document_id}", json={"name": name})
        return data if isinstance(data, dict) else {}

    async def create_dataset(self, name: str, description: str, embedding_model: str = "") -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "description": description,
            "permission": "me",
            "chunk_method": "laws",
            "parser_config": {"raptor": {"use_raptor": False}},
        }
        if embedding_model:
            body["embedding_model"] = embedding_model
        return await self._request("POST", "/api/v1/datasets", json=body)

    async def upload_document(self, dataset_id: str, filename: str, content: bytes, content_type: str) -> list[dict[str, Any]]:
        data = await self._request(
            "POST",
            f"/api/v1/datasets/{dataset_id}/documents",
            files={"file": (filename, content, content_type or "application/octet-stream")},
        )
        return data if isinstance(data, list) else [data]

    async def parse_documents(self, dataset_id: str, document_ids: list[str]) -> None:
        await self._request("POST", f"/api/v1/datasets/{dataset_id}/chunks", json={"document_ids": document_ids})

    async def list_documents(self, dataset_id: str) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/api/v1/datasets/{dataset_id}/documents", params={"page": 1, "page_size": 100})
        if isinstance(data, dict):
            return data.get("docs", [])
        return []

    async def create_chat(self, name: str, dataset_ids: str | list[str], llm_id: str = "") -> dict[str, Any]:
        if isinstance(dataset_ids, str):
            dataset_ids = [dataset_ids]
        dataset_ids = list(dict.fromkeys(item for item in dataset_ids if item))
        if not dataset_ids:
            raise RagflowError("至少需要一个知识库数据集", 400)
        body: dict[str, Any] = {
            "name": name,
            "dataset_ids": dataset_ids,
            "llm_setting": {"temperature": 0.1, "top_p": 0.3, "presence_penalty": 0.2, "frequency_penalty": 0.2},
            "prompt_config": {
                "system": "/no_think\n你是 ShopMind 企业售后规则问答助手。你的任务是根据知识库资料回答用户问题。\n\n回答要求：\n1. 先直接给出结论，不要复述或改写用户问题。\n2. 只使用知识库资料，不得编造；资料不足时明确说明知识库暂无足够依据。\n3. 如果知识库包含与问题直接对应的 FAQ 或明确规则，优先准确概括该内容。\n4. 使用简洁中文纯文本，按短段落换行；不要输出 Markdown 标题、井号、星号、表格竖线、代码块、分隔线、引用标记或内部分析。\n\n知识库资料：\n{knowledge}",
                "prologue": "您好，我可以帮助检索商品、活动、物流及售后规则。",
                "parameters": [{"key": "knowledge", "optional": False}],
                "empty_response": "当前知识库中没有足够依据，请转交人工确认。",
                # References are returned separately and rendered by ShopMind.
                # Disabling inline citation generation avoids RAGFlow appending
                # a very large citation instruction prompt to local models.
                "quote": False,
                "refine_multiturn": False,
            },
            "similarity_threshold": 0.2,
            "vector_similarity_weight": 0.3,
            "top_n": 5,
        }
        if llm_id:
            body["llm_id"] = llm_id
        return await self._request("POST", "/api/v1/chats", json=body)

    async def update_chat_prompt(self, chat_id: str, system_prompt: str) -> dict[str, Any]:
        data = await self._request(
            "PATCH",
            f"/api/v1/chats/{chat_id}",
            json={"prompt_config": {"system": system_prompt}},
        )
        return data if isinstance(data, dict) else {}

    async def create_session(self, chat_id: str, name: str, user_id: str) -> dict[str, Any]:
        return await self._request("POST", f"/api/v1/chats/{chat_id}/sessions", json={"name": name, "user_id": user_id})

    async def complete(self, chat_id: str, session_id: str, messages: list[dict[str, str]]) -> dict[str, Any]:
        data = await self._request(
            "POST",
            "/api/v1/chat/completions",
            json={
                "chat_id": chat_id,
                "session_id": session_id,
                "messages": messages,
                "pass_all_history_messages": True,
                "stream": False,
            },
        )
        if not isinstance(data, dict):
            raise RagflowError("RAGFlow returned an invalid completion response")
        return data
