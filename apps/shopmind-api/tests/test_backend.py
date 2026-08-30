from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from shopmind.cache import MemorySessionCache
from shopmind.config import Settings
from shopmind.database import Database
from shopmind.main import create_app
from shopmind.main import completion_answer, normalize_answer, redact_remote_value
from shopmind.security import hash_password


class FakeRagflow:
    configured = True
    api_key = "test-key"
    deleted_datasets = []
    deleted_documents = []
    updated_datasets = []
    updated_documents = []

    async def health(self):
        return {"reachable": True, "detail": {"status": "ok"}}

    async def list_providers(self, available=False):
        return [{"name": "ollama", "api_key": "should-not-leak", "available": True}]

    async def list_models(self, model_type=None):
        return [{"model_id": "qwen3", "model_name": "qwen3", "model_type": "chat", "token": "hidden"}]

    async def list_default_models(self):
        return [{"model_id": "qwen3", "model_type": "chat"}]

    async def create_dataset(self, name, description, embedding_model=""):
        return {"id": f"dataset-{name}"}

    async def update_dataset(self, dataset_id, name, description):
        self.updated_datasets.append((dataset_id, name, description))
        return {"id": dataset_id, "name": name}

    async def delete_dataset(self, dataset_id):
        self.deleted_datasets.append(dataset_id)

    async def delete_chat(self, chat_id):
        return None

    async def upload_document(self, dataset_id, filename, content, content_type):
        return [{"id": "doc-1", "name": filename, "size": len(content), "run": "UNSTART"}]

    async def parse_documents(self, dataset_id, document_ids):
        return None

    async def update_document(self, dataset_id, document_id, name):
        self.updated_documents.append((dataset_id, document_id, name))
        return {"id": document_id, "name": name}

    async def delete_documents(self, dataset_id, document_ids):
        self.deleted_documents.append((dataset_id, document_ids))

    async def list_documents(self, dataset_id):
        return [{"id": "doc-1", "name": "rules.md", "run": "DONE", "progress": 1}]

    async def create_chat(self, name, dataset_id, llm_id=""):
        return {"id": "chat-1"}

    async def create_session(self, chat_id, name, user_id):
        return {"id": "session-1"}

    async def complete(self, chat_id, session_id, messages):
        return {"answer": "根据规则，可以在有效期内申请。", "reference": {"chunks": [{"document_keyword": "rules.md", "content": "规则依据"}]}}


class ShopMindApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        db_path = str(Path(self.tempdir.name) / "test.db")
        settings = Settings(
            database_path=db_path,
            redis_url="redis://unused/2",
            admin_username="admin",
            admin_password="AdminPass@2026",
            ragflow_api_key="test-key",
            ragflow_env_file=str(Path(self.tempdir.name) / "ragflow.env"),
        )
        Path(settings.ragflow_env_file).write_text("RAGFLOW_API_KEY=test-key\nOTHER=value\n", encoding="utf-8")
        self.app = create_app(settings, Database(db_path), MemorySessionCache(), FakeRagflow())
        self.client_context = TestClient(self.app)
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.tempdir.cleanup()

    def login(self):
        response = self.client.post("/api/v1/auth/login", json={"username": "admin", "password": "AdminPass@2026"})
        self.assertEqual(response.status_code, 200)

    def login_as(self, username, password):
        response = self.client.post("/api/v1/auth/login", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200)

    def test_login_requires_valid_password(self):
        response = self.client.post("/api/v1/auth/login", json={"username": "admin", "password": "wrong"})
        self.assertEqual(response.status_code, 401)

    def test_knowledge_version_publish_and_chat(self):
        self.login()
        kb = self.client.post("/api/v1/knowledge-bases", json={"name": "售后规则", "description": "内部演示"})
        self.assertEqual(kb.status_code, 201)
        kb_id = kb.json()["id"]
        versions = self.client.get(f"/api/v1/knowledge-bases/{kb_id}/versions").json()["items"]
        version_id = versions[0]["id"]
        upload = self.client.post(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents",
            files={"file": ("rules.md", b"# Rules", "text/markdown")},
        )
        self.assertEqual(upload.status_code, 201)
        publish = self.client.post(f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/publish")
        self.assertEqual(publish.status_code, 200)
        conversation = self.client.post("/api/v1/conversations", json={"knowledge_base_id": kb_id, "title": "退款咨询"})
        self.assertEqual(conversation.status_code, 201)
        reply = self.client.post(
            f"/api/v1/conversations/{conversation.json()['id']}/messages", json={"content": "可以退款吗？"}
        )
        self.assertEqual(reply.status_code, 201)
        self.assertEqual(reply.json()["assistant_message"]["references"][0]["document_keyword"], "rules.md")

    def test_sync_metadata_is_idempotent_and_queryable(self):
        self.login()
        db = self.app.state.db
        mapping = db.upsert_external_resource(
            "ragflow",
            "dataset",
            "dataset-1",
            local_resource_type="knowledge_base",
            local_resource_id="kb-1",
            display_name="售后规则",
        )
        updated = db.upsert_external_resource(
            "ragflow",
            "dataset",
            "dataset-1",
            local_resource_type="knowledge_base",
            local_resource_id="kb-1",
            remote_revision="rev-2",
            display_name="售后规则新版",
        )
        self.assertEqual(mapping["id"], updated["id"])
        self.assertEqual(db.list_external_resources(resource_type="dataset")[0]["remote_revision"], "rev-2")

        job = db.create_sync_job("ragflow", "all", ["models", "datasets"], created_by="admin")
        self.assertEqual(job["status"], "queued")
        db.update_sync_job(job["id"], status="running", increment_attempt=True)
        self.assertEqual(db.get_sync_job(job["id"])["attempts"], 1)

        cursor = db.upsert_sync_cursor("ragflow", "datasets", "cursor-1")
        self.assertEqual(cursor["cursor"], "cursor-1")
        conflict = db.create_resource_conflict(
            "metadata_changed",
            external_resource_id=updated["id"],
            local_resource_type="knowledge_base",
            local_resource_id="kb-1",
            remote_resource_id="dataset-1",
            local_snapshot={"name": "售后规则"},
            remote_snapshot={"name": "售后规则新版"},
        )
        self.assertEqual(db.list_resource_conflicts()[0]["id"], conflict["id"])

        event = db.add_outbox_event("knowledge_version", "version-1", "knowledge.publish", {"version": 1})
        self.assertEqual(db.list_pending_outbox_events()[0]["id"], event["id"])
        db.mark_outbox_event(event["id"], status="processed")
        self.assertEqual(db.list_pending_outbox_events(), [])

    def test_knowledge_management_edit_and_delete_cascade(self):
        self.login()
        kb = self.client.post("/api/v1/knowledge-bases", json={"name": "可编辑规则", "description": "旧说明"})
        self.assertEqual(kb.status_code, 201)
        kb_id = kb.json()["id"]
        version = self.client.get(f"/api/v1/knowledge-bases/{kb_id}/versions").json()["items"][0]
        version_id = version["id"]
        upload = self.client.post(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents",
            files={"file": ("old.md", b"# Rules", "text/markdown")},
        )
        self.assertEqual(upload.status_code, 201)
        document_id = upload.json()["items"][0]["id"]

        updated_kb = self.client.patch(f"/api/v1/knowledge-bases/{kb_id}", json={"name": "新规则", "description": "新说明"})
        self.assertEqual(updated_kb.status_code, 200)
        self.assertEqual(updated_kb.json()["name"], "新规则")
        self.assertTrue(self.app.state.ragflow.updated_datasets)

        updated_version = self.client.patch(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}", json={"name": "售后草稿"}
        )
        self.assertEqual(updated_version.status_code, 200)
        self.assertEqual(updated_version.json()["name"], "售后草稿")

        updated_document = self.client.patch(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents/{document_id}",
            json={"name": "new.md"},
        )
        self.assertEqual(updated_document.status_code, 200)
        self.assertEqual(updated_document.json()["name"], "new.md")

        deleted_document = self.client.delete(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents/{document_id}"
        )
        self.assertEqual(deleted_document.status_code, 200)
        self.assertTrue(self.app.state.ragflow.deleted_documents)

        deleted_version = self.client.delete(f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}")
        self.assertEqual(deleted_version.status_code, 200)
        self.assertIn(version["ragflow_dataset_id"], self.app.state.ragflow.deleted_datasets)

        deleted_kb = self.client.delete(f"/api/v1/knowledge-bases/{kb_id}")
        self.assertEqual(deleted_kb.status_code, 200)
        self.assertEqual(self.client.get("/api/v1/knowledge-bases").json()["items"], [])

    def test_admin_ragflow_endpoints_are_protected_and_redacted(self):
        self.login()
        providers = self.client.get("/api/v1/admin/ragflow/providers")
        self.assertEqual(providers.status_code, 200)
        body = providers.json()
        self.assertEqual(body["providers"][0]["name"], "ollama")
        self.assertNotIn("api_key", body["providers"][0])
        self.assertNotIn("token", body["models"][0])

        status_response = self.client.get("/api/v1/admin/ragflow/config-status")
        self.assertEqual(status_response.status_code, 200)
        self.assertTrue(status_response.json()["configured"])
        self.assertEqual(status_response.json()["model_count"], 1)

        sync = self.client.post("/api/v1/admin/ragflow/sync", json={"scope": "all", "resource_types": ["models", "models"]})
        self.assertEqual(sync.status_code, 202)
        job = self.client.get(f"/api/v1/admin/sync/jobs/{sync.json()['job_id']}")
        self.assertEqual(job.status_code, 200)
        self.assertEqual(job.json()["resource_types"], ["models"])

        invalid = self.client.post("/api/v1/admin/ragflow/sync", json={"resource_types": ["secrets"]})
        self.assertEqual(invalid.status_code, 400)

        db = self.app.state.db
        with db.connection() as connection:
            connection.execute(
                "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
                ("staff-1", "staff", hash_password("StaffPass@2026"), "客服员工", "staff", "2026-08-28T00:00:00+00:00"),
            )
        self.client.post("/api/v1/auth/logout")
        self.login_as("staff", "StaffPass@2026")
        self.assertEqual(self.client.get("/api/v1/admin/ragflow/providers").status_code, 403)
        self.assertEqual(self.client.post("/api/v1/admin/ragflow/sync", json={}).status_code, 403)

    def test_redaction_preserves_non_sensitive_token_counts(self):
        value = redact_remote_value({
            "token_count": 42,
            "access_token": "secret",
            "nested": {"api-key": "secret", "model_name": "qwen3"},
        })
        self.assertEqual(value["token_count"], 42)
        self.assertNotIn("access_token", value)
        self.assertNotIn("api-key", value["nested"])
        self.assertEqual(value["nested"]["model_name"], "qwen3")

    def test_answer_formatting_removes_markdown_noise(self):
        raw = "## 退款方式\n\n| 类型 | 时效 |\n| --- | --- |\n| 原路退回 | 24 小时 |\n\n**请注意**：以审核结果为准。"
        normalized = normalize_answer(raw)
        self.assertEqual(normalized, "退款方式\n\n类型\n时效\n原路退回\n24 小时\n\n请注意：以审核结果为准。")
        self.assertNotIn('|', normalized)
        self.assertNotIn('---', normalized)
        self.assertEqual(normalize_answer('配送方式；预计 48 小时内发出'), '配送方式\n预计 48 小时内发出')
        self.assertEqual(completion_answer({"answer": "### 结论\n可以申请。"}), "结论\n可以申请。")

    def test_admin_openapi_contains_sync_contracts(self):
        schema = self.client.get("/openapi.json").json()
        self.assertIn("/api/v1/admin/ragflow/providers", schema["paths"])
        self.assertIn("/api/v1/admin/ragflow/sync", schema["paths"])
        self.assertIn("/api/v1/admin/sync/jobs/{job_id}", schema["paths"])

    def test_admin_can_update_ragflow_api_key_without_exposing_secret(self):
        self.login()
        config = self.client.get("/api/v1/admin/ragflow/config")
        self.assertEqual(config.status_code, 200)
        self.assertTrue(config.json()["configured"])
        self.assertNotIn("test-key", config.text)

        updated = self.client.put("/api/v1/admin/ragflow/config", json={"api_key": "RAGFlow-new-secret-2026"})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["masked_key"], "RAGFlow••••2026")
        self.assertNotIn("new-secret", updated.text)
        self.assertEqual(self.app.state.ragflow.api_key, "RAGFlow-new-secret-2026")
        env_text = Path(self.app.state.settings.ragflow_env_file).read_text(encoding="utf-8")
        self.assertIn("RAGFLOW_API_KEY=RAGFlow-new-secret-2026", env_text)
        self.assertIn("OTHER=value", env_text)

        invalid = self.client.put("/api/v1/admin/ragflow/config", json={"api_key": "wrong-key"})
        self.assertEqual(invalid.status_code, 422)

    def test_message_history_returns_latest_messages_in_chronological_order(self):
        db = self.app.state.db
        user = db.get_user_by_username("admin")
        knowledge_base = db.create_knowledge_base("上下文测试", "", user["id"], "dataset-context")
        conversation = db.create_conversation(user["id"], [knowledge_base["id"]], "上下文")
        for index in range(30):
            db.add_message(conversation["id"], "user", f"消息-{index}")

        messages = db.list_messages(conversation["id"], 5)
        self.assertEqual([item["content"] for item in messages], ["消息-25", "消息-26", "消息-27", "消息-28", "消息-29"])

    def test_publishing_an_active_version_is_rejected(self):
        self.login()
        kb = self.client.post("/api/v1/knowledge-bases", json={"name": "发布幂等", "description": ""})
        self.assertEqual(kb.status_code, 201)
        kb_id = kb.json()["id"]
        version_id = self.client.get(f"/api/v1/knowledge-bases/{kb_id}/versions").json()["items"][0]["id"]
        self.client.post(
            f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/documents",
            files={"file": ("publish.md", b"# Rules", "text/markdown")},
        )
        self.assertEqual(self.client.post(f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/publish").status_code, 200)
        repeated = self.client.post(f"/api/v1/knowledge-bases/{kb_id}/versions/{version_id}/publish")
        self.assertEqual(repeated.status_code, 409)


if __name__ == "__main__":
    unittest.main()
