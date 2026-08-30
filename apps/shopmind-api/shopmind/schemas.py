from __future__ import annotations

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=500)


class KnowledgeBaseUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=500)


class KnowledgeVersionUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class KnowledgeDocumentUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class ConversationCreate(BaseModel):
    knowledge_base_id: str | None = None
    knowledge_base_ids: list[str] = Field(default_factory=list, max_length=20)
    title: str = Field(default="新会话", min_length=1, max_length=80)


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=8000)


class RagflowSyncRequest(BaseModel):
    scope: str = Field(default="all", min_length=1, max_length=120)
    resource_types: list[str] = Field(
        default_factory=lambda: ["providers", "models", "datasets", "documents", "chats"],
        min_length=1,
        max_length=10,
    )


class RagflowApiKeyUpdate(BaseModel):
    api_key: str = Field(min_length=8, max_length=512)
