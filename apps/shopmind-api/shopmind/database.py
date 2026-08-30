from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .security import hash_password


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        if self.path != ":memory:":
            connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self, admin_username: str, admin_password: str) -> None:
        schema = """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL,
            active_version_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_versions (
            id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, version_number INTEGER NOT NULL,
            status TEXT NOT NULL, ragflow_dataset_id TEXT NOT NULL, ragflow_chat_id TEXT, name TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT,
            FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            UNIQUE(knowledge_base_id, version_number)
        );
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, version_id TEXT NOT NULL, ragflow_document_id TEXT NOT NULL,
            name TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
            FOREIGN KEY(version_id) REFERENCES knowledge_versions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, user_id TEXT NOT NULL, knowledge_base_id TEXT NOT NULL,
            knowledge_version_id TEXT, ragflow_chat_id TEXT, ragflow_session_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            knowledge_base_ids_json TEXT NOT NULL DEFAULT '[]',
            knowledge_version_ids_json TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(knowledge_base_id) REFERENCES knowledge_bases(id)
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
            references_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL,
            resource_id TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS external_resources (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            local_resource_type TEXT NOT NULL DEFAULT '',
            local_resource_id TEXT NOT NULL DEFAULT '',
            remote_resource_id TEXT NOT NULL,
            remote_revision TEXT NOT NULL DEFAULT '',
            content_checksum TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            sync_state TEXT NOT NULL DEFAULT 'synced',
            last_synced_at TEXT,
            last_error TEXT NOT NULL DEFAULT '',
            deleted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(provider, resource_type, remote_resource_id)
        );
        CREATE INDEX IF NOT EXISTS idx_external_resources_local
            ON external_resources(local_resource_type, local_resource_id, resource_type);
        CREATE INDEX IF NOT EXISTS idx_external_resources_sync_state
            ON external_resources(sync_state, updated_at);
        CREATE TABLE IF NOT EXISTS sync_jobs (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            scope TEXT NOT NULL,
            resource_types_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            next_attempt_at TEXT,
            started_at TEXT,
            finished_at TEXT,
            last_error TEXT NOT NULL DEFAULT '',
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_jobs_status
            ON sync_jobs(status, next_attempt_at, created_at);
        CREATE TABLE IF NOT EXISTS sync_cursors (
            provider TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            cursor TEXT NOT NULL DEFAULT '',
            last_synced_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(provider, resource_type)
        );
        CREATE TABLE IF NOT EXISTS resource_conflicts (
            id TEXT PRIMARY KEY,
            external_resource_id TEXT,
            local_resource_type TEXT NOT NULL DEFAULT '',
            local_resource_id TEXT NOT NULL DEFAULT '',
            remote_resource_id TEXT NOT NULL DEFAULT '',
            conflict_type TEXT NOT NULL,
            local_snapshot_json TEXT NOT NULL DEFAULT '{}',
            remote_snapshot_json TEXT NOT NULL DEFAULT '{}',
            resolution TEXT NOT NULL DEFAULT 'pending',
            resolved_by TEXT,
            resolved_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(external_resource_id) REFERENCES external_resources(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resource_conflicts_resolution
            ON resource_conflicts(resolution, created_at);
        CREATE TABLE IF NOT EXISTS outbox_events (
            id TEXT PRIMARY KEY,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            last_error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            processed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
            ON outbox_events(status, next_attempt_at, created_at);
        """
        with self._lock, self.connection() as connection:
            connection.executescript(schema)
            # Keep upgrades backward-compatible with databases created before
            # version metadata editing was introduced.
            columns = {row[1] for row in connection.execute("PRAGMA table_info(knowledge_versions)").fetchall()}
            if "name" not in columns:
                connection.execute("ALTER TABLE knowledge_versions ADD COLUMN name TEXT NOT NULL DEFAULT ''")
            conversation_columns = {row[1] for row in connection.execute("PRAGMA table_info(conversations)").fetchall()}
            if "knowledge_base_ids_json" not in conversation_columns:
                connection.execute("ALTER TABLE conversations ADD COLUMN knowledge_base_ids_json TEXT NOT NULL DEFAULT '[]'")
            if "knowledge_version_ids_json" not in conversation_columns:
                connection.execute("ALTER TABLE conversations ADD COLUMN knowledge_version_ids_json TEXT NOT NULL DEFAULT '[]'")
            connection.execute(
                "UPDATE conversations SET knowledge_base_ids_json = json_array(knowledge_base_id) WHERE knowledge_base_ids_json IS NULL OR knowledge_base_ids_json = '[]'"
            )
            existing = connection.execute("SELECT id FROM users WHERE username = ?", (admin_username,)).fetchone()
            if not existing:
                connection.execute(
                    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), admin_username, hash_password(admin_password), "系统管理员", "admin", utc_now()),
                )

    @staticmethod
    def _dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row else None

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone())

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def audit(self, user_id: str | None, action: str, resource_type: str, resource_id: str | None, detail: dict[str, Any] | None = None) -> None:
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), user_id, action, resource_type, resource_id, json.dumps(detail or {}, ensure_ascii=False), utc_now()),
            )

    def create_knowledge_base(self, name: str, description: str, user_id: str, dataset_id: str) -> dict[str, Any]:
        kb_id, version_id, now = str(uuid.uuid4()), str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO knowledge_bases VALUES (?, ?, ?, NULL, ?, ?, ?)",
                (kb_id, name, description, user_id, now, now),
            )
            connection.execute(
                "INSERT INTO knowledge_versions (id, knowledge_base_id, version_number, status, ragflow_dataset_id, ragflow_chat_id, created_by, created_at, published_at, name) VALUES (?, ?, 1, 'draft', ?, NULL, ?, ?, NULL, ?)",
                (version_id, kb_id, dataset_id, user_id, now, "V1"),
            )
        return self.get_knowledge_base(kb_id) or {}

    def get_knowledge_base(self, kb_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                """SELECT kb.*, v.version_number AS active_version_number, v.status AS active_version_status
                   FROM knowledge_bases kb LEFT JOIN knowledge_versions v ON v.id = kb.active_version_id
                   WHERE kb.id = ?""",
                (kb_id,),
            ).fetchone()
            return self._dict(row)

    def list_knowledge_bases(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT kb.*, v.version_number AS active_version_number, v.status AS active_version_status,
                          (SELECT COUNT(*) FROM knowledge_versions kv WHERE kv.knowledge_base_id = kb.id) AS version_count
                   FROM knowledge_bases kb LEFT JOIN knowledge_versions v ON v.id = kb.active_version_id
                   ORDER BY kb.updated_at DESC"""
            ).fetchall()
            return [dict(row) for row in rows]

    def list_versions(self, kb_id: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT v.*, (SELECT COUNT(*) FROM documents d WHERE d.version_id = v.id) AS document_count
                   FROM knowledge_versions v WHERE knowledge_base_id = ? ORDER BY version_number DESC""",
                (kb_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_version(self, version_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM knowledge_versions WHERE id = ?", (version_id,)).fetchone())

    def create_version(self, kb_id: str, user_id: str, dataset_id: str) -> dict[str, Any]:
        version_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            next_number = connection.execute(
                "SELECT COALESCE(MAX(version_number), 0) + 1 FROM knowledge_versions WHERE knowledge_base_id = ?",
                (kb_id,),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO knowledge_versions (id, knowledge_base_id, version_number, status, ragflow_dataset_id, ragflow_chat_id, created_by, created_at, published_at, name) VALUES (?, ?, ?, 'draft', ?, NULL, ?, ?, NULL, ?)",
                (version_id, kb_id, next_number, dataset_id, user_id, now, f"V{next_number}"),
            )
        return self.get_version(version_id) or {}

    def add_document(self, version_id: str, ragflow_document_id: str, name: str, size: int, status: str) -> dict[str, Any]:
        document_id = str(uuid.uuid4())
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)",
                (document_id, version_id, ragflow_document_id, name, size, status, utc_now()),
            )
        return self.get_document_by_ragflow_id(ragflow_document_id) or {}

    def get_document_by_ragflow_id(self, ragflow_document_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM documents WHERE ragflow_document_id = ?", (ragflow_document_id,)).fetchone())

    def update_document_status(self, ragflow_document_id: str, status: str, progress: float, error: str = "") -> None:
        with self.connection() as connection:
            connection.execute(
                "UPDATE documents SET status = ?, progress = ?, error_message = ? WHERE ragflow_document_id = ?",
                (status, progress, error, ragflow_document_id),
            )

    def list_documents(self, version_id: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM documents WHERE version_id = ? ORDER BY created_at DESC", (version_id,)).fetchall()]

    def update_knowledge_base(self, kb_id: str, name: str, description: str) -> dict[str, Any] | None:
        with self._lock, self.connection() as connection:
            connection.execute("UPDATE knowledge_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?", (name, description, utc_now(), kb_id))
        return self.get_knowledge_base(kb_id)

    def update_version(self, version_id: str, name: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            connection.execute("UPDATE knowledge_versions SET name = ? WHERE id = ?", (name, version_id))
        return self.get_version(version_id)

    def update_document_name(self, document_id: str, name: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            connection.execute("UPDATE documents SET name = ? WHERE id = ?", (name, document_id))
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone())

    def get_document(self, document_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone())

    def delete_document(self, document_id: str) -> None:
        with self.connection() as connection:
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))

    def delete_version(self, version_id: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM knowledge_versions WHERE id = ?", (version_id,))

    def delete_knowledge_base(self, kb_id: str) -> None:
        # Conversations reference knowledge bases without a database cascade.
        # Remove dependent messages/conversations explicitly before the KB.
        with self._lock, self.connection() as connection:
            conversation_ids = []
            for row in connection.execute("SELECT id, knowledge_base_id, knowledge_base_ids_json FROM conversations").fetchall():
                try:
                    linked_ids = json.loads(row[2] or "[]")
                except (TypeError, ValueError):
                    linked_ids = []
                if row[1] == kb_id or kb_id in linked_ids:
                    conversation_ids.append(row[0])
            if conversation_ids:
                placeholders = ",".join("?" for _ in conversation_ids)
                connection.execute(f"DELETE FROM messages WHERE conversation_id IN ({placeholders})", conversation_ids)
                connection.execute(f"DELETE FROM conversations WHERE id IN ({placeholders})", conversation_ids)
            connection.execute("DELETE FROM external_resources WHERE local_resource_id = ?", (kb_id,))
            connection.execute("DELETE FROM knowledge_bases WHERE id = ?", (kb_id,))

    def activate_version(self, kb_id: str, version_id: str, chat_id: str) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self.connection() as connection:
            version = connection.execute(
                "SELECT * FROM knowledge_versions WHERE id = ? AND knowledge_base_id = ?", (version_id, kb_id)
            ).fetchone()
            if not version:
                raise ValueError("Knowledge version not found")
            connection.execute(
                "UPDATE knowledge_versions SET status = 'archived' WHERE knowledge_base_id = ? AND status = 'active'",
                (kb_id,),
            )
            connection.execute(
                "UPDATE knowledge_versions SET status = 'active', ragflow_chat_id = ?, published_at = ? WHERE id = ?",
                (chat_id, now, version_id),
            )
            connection.execute(
                "UPDATE knowledge_bases SET active_version_id = ?, updated_at = ? WHERE id = ?",
                (version_id, now, kb_id),
            )
        return self.get_version(version_id) or {}

    def get_active_version(self, kb_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(
                connection.execute(
                    """SELECT v.* FROM knowledge_versions v JOIN knowledge_bases kb ON kb.active_version_id = v.id
                       WHERE kb.id = ? AND v.status = 'active'""",
                    (kb_id,),
                ).fetchone()
            )

    def _enrich_conversation(self, conversation: dict[str, Any] | None) -> dict[str, Any] | None:
        if not conversation:
            return None
        try:
            kb_ids = json.loads(conversation.get("knowledge_base_ids_json") or "[]")
        except (TypeError, ValueError):
            kb_ids = []
        if not isinstance(kb_ids, list) or not kb_ids:
            kb_ids = [conversation.get("knowledge_base_id")]
        kb_ids = [str(item) for item in kb_ids if item]
        with self.connection() as connection:
            rows = connection.execute(
                f"SELECT id, name FROM knowledge_bases WHERE id IN ({','.join('?' for _ in kb_ids)})",
                kb_ids,
            ).fetchall() if kb_ids else []
        names_by_id = {row[0]: row[1] for row in rows}
        conversation["knowledge_base_ids"] = kb_ids
        conversation["knowledge_base_names"] = [names_by_id[item] for item in kb_ids if item in names_by_id]
        conversation["knowledge_base_name"] = "、".join(conversation["knowledge_base_names"])
        return conversation

    def conversation_knowledge_base_ids(self, conversation: dict[str, Any]) -> list[str]:
        try:
            ids = json.loads(conversation.get("knowledge_base_ids_json") or "[]")
        except (TypeError, ValueError):
            ids = []
        if not isinstance(ids, list) or not ids:
            ids = [conversation.get("knowledge_base_id")]
        return list(dict.fromkeys(str(item) for item in ids if item))

    def conversation_knowledge_version_ids(self, conversation: dict[str, Any]) -> list[str]:
        try:
            ids = json.loads(conversation.get("knowledge_version_ids_json") or "[]")
        except (TypeError, ValueError):
            ids = []
        if not isinstance(ids, list):
            ids = []
        return [str(item) for item in ids if item]

    def create_conversation(self, user_id: str, kb_ids: list[str], title: str) -> dict[str, Any]:
        kb_ids = list(dict.fromkeys(kb_ids))
        if not kb_ids:
            raise ValueError("At least one knowledge base is required")
        conversation_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO conversations
                   (id, title, user_id, knowledge_base_id, knowledge_version_id, ragflow_chat_id, ragflow_session_id,
                    created_at, updated_at, knowledge_base_ids_json, knowledge_version_ids_json)
                   VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, '[]')""",
                (conversation_id, title, user_id, kb_ids[0], now, now, json.dumps(kb_ids, ensure_ascii=False)),
            )
        return self.get_conversation(conversation_id) or {}
        conversation_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO conversations VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
                (conversation_id, title, user_id, kb_id, now, now),
            )
        return self.get_conversation(conversation_id) or {}

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = self._dict(connection.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone())
        return self._enrich_conversation(row)

    def list_conversations(self, user_id: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = [dict(row) for row in connection.execute(
                "SELECT c.* FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT 100", (user_id,)
            ).fetchall()]
        return [self._enrich_conversation(row) or {} for row in rows]

    def bind_conversation(self, conversation_id: str, version_id: str, chat_id: str, session_id: str, version_ids: list[str] | None = None) -> None:
        with self.connection() as connection:
            connection.execute(
                """UPDATE conversations SET knowledge_version_id = ?, ragflow_chat_id = ?, ragflow_session_id = ?,
                          knowledge_version_ids_json = ?, updated_at = ?
                   WHERE id = ?""",
                (version_id, chat_id, session_id, json.dumps(version_ids or [version_id], ensure_ascii=False), utc_now(), conversation_id),
            )

    def delete_conversation(self, conversation_id: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))

    def add_message(self, conversation_id: str, role: str, content: str, references: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        message_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)",
                (message_id, conversation_id, role, content, json.dumps(references or [], ensure_ascii=False), now),
            )
            connection.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            row = connection.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        result = dict(row)
        result["references"] = json.loads(result.pop("references_json"))
        return result

    def list_messages(self, conversation_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
                (conversation_id, limit),
            ).fetchall()
        rows = list(reversed(rows))
        result = []
        for row in rows:
            item = dict(row)
            item["references"] = json.loads(item.pop("references_json"))
            result.append(item)
        return result

    def delete_message(self, message_id: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM messages WHERE id = ?", (message_id,))

    def dashboard(self) -> dict[str, int]:
        with self.connection() as connection:
            return {
                "knowledge_bases": connection.execute("SELECT COUNT(*) FROM knowledge_bases").fetchone()[0],
                "active_versions": connection.execute("SELECT COUNT(*) FROM knowledge_versions WHERE status = 'active'").fetchone()[0],
                "documents": connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
                "conversations": connection.execute("SELECT COUNT(*) FROM conversations").fetchone()[0],
            }

    def upsert_external_resource(
        self,
        provider: str,
        resource_type: str,
        remote_resource_id: str,
        *,
        local_resource_type: str = "",
        local_resource_id: str = "",
        remote_revision: str = "",
        content_checksum: str = "",
        display_name: str = "",
        sync_state: str = "synced",
        last_error: str = "",
        deleted_at: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self.connection() as connection:
            existing = connection.execute(
                "SELECT id FROM external_resources WHERE provider = ? AND resource_type = ? AND remote_resource_id = ?",
                (provider, resource_type, remote_resource_id),
            ).fetchone()
            if existing:
                connection.execute(
                    """UPDATE external_resources
                       SET local_resource_type = ?, local_resource_id = ?, remote_revision = ?,
                           content_checksum = ?, display_name = ?, sync_state = ?, last_synced_at = ?,
                           last_error = ?, deleted_at = ?, updated_at = ?
                       WHERE id = ?""",
                    (
                        local_resource_type,
                        local_resource_id,
                        remote_revision,
                        content_checksum,
                        display_name,
                        sync_state,
                        now,
                        last_error,
                        deleted_at,
                        now,
                        existing[0],
                    ),
                )
                resource_id = existing[0]
            else:
                resource_id = str(uuid.uuid4())
                connection.execute(
                    """INSERT INTO external_resources
                       (id, provider, resource_type, local_resource_type, local_resource_id,
                        remote_resource_id, remote_revision, content_checksum, display_name,
                        sync_state, last_synced_at, last_error, deleted_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        resource_id,
                        provider,
                        resource_type,
                        local_resource_type,
                        local_resource_id,
                        remote_resource_id,
                        remote_revision,
                        content_checksum,
                        display_name,
                        sync_state,
                        now,
                        last_error,
                        deleted_at,
                        now,
                        now,
                    ),
                )
        return self.get_external_resource(resource_id) or {}

    def get_external_resource(self, resource_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute("SELECT * FROM external_resources WHERE id = ?", (resource_id,)).fetchone())

    def find_external_resource(self, provider: str, resource_type: str, remote_resource_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute(
                "SELECT * FROM external_resources WHERE provider = ? AND resource_type = ? AND remote_resource_id = ?",
                (provider, resource_type, remote_resource_id),
            ).fetchone())

    def list_external_resources(
        self,
        *,
        provider: str | None = None,
        resource_type: str | None = None,
        sync_state: str | None = None,
        local_resource_id: str | None = None,
    ) -> list[dict[str, Any]]:
        conditions: list[str] = []
        values: list[Any] = []
        for column, value in (
            ("provider", provider),
            ("resource_type", resource_type),
            ("sync_state", sync_state),
            ("local_resource_id", local_resource_id),
        ):
            if value is not None:
                conditions.append(f"{column} = ?")
                values.append(value)
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        with self.connection() as connection:
            rows = connection.execute(f"SELECT * FROM external_resources{where} ORDER BY updated_at DESC", values).fetchall()
            return [dict(row) for row in rows]

    def create_sync_job(
        self,
        provider: str,
        scope: str,
        resource_types: list[str],
        *,
        created_by: str | None = None,
        max_attempts: int = 5,
    ) -> dict[str, Any]:
        job_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO sync_jobs
                   (id, provider, scope, resource_types_json, status, attempts, max_attempts,
                    next_attempt_at, started_at, finished_at, last_error, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, '', ?, ?, ?)""",
                (job_id, provider, scope, json.dumps(resource_types, ensure_ascii=False), max_attempts, now, created_by, now, now),
            )
        return self.get_sync_job(job_id) or {}

    def get_sync_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM sync_jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result["resource_types"] = json.loads(result.pop("resource_types_json"))
            return result

    def update_sync_job(self, job_id: str, *, status: str, error: str = "", increment_attempt: bool = False) -> dict[str, Any] | None:
        now = utc_now()
        with self._lock, self.connection() as connection:
            if increment_attempt:
                connection.execute(
                    "UPDATE sync_jobs SET status = ?, attempts = attempts + 1, last_error = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
                    (status, error, now, now, job_id),
                )
            else:
                connection.execute(
                    "UPDATE sync_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
                    (status, error, now, job_id),
                )
            if status in {"succeeded", "failed", "dead"}:
                connection.execute("UPDATE sync_jobs SET finished_at = ?, updated_at = ? WHERE id = ?", (now, now, job_id))
        return self.get_sync_job(job_id)

    def upsert_sync_cursor(self, provider: str, resource_type: str, cursor: str) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self.connection() as connection:
            connection.execute(
                """INSERT INTO sync_cursors(provider, resource_type, cursor, last_synced_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(provider, resource_type) DO UPDATE SET cursor = excluded.cursor,
                   last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at""",
                (provider, resource_type, cursor, now, now),
            )
        return self.get_sync_cursor(provider, resource_type) or {}

    def get_sync_cursor(self, provider: str, resource_type: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._dict(connection.execute(
                "SELECT * FROM sync_cursors WHERE provider = ? AND resource_type = ?",
                (provider, resource_type),
            ).fetchone())

    def create_resource_conflict(
        self,
        conflict_type: str,
        *,
        external_resource_id: str | None = None,
        local_resource_type: str = "",
        local_resource_id: str = "",
        remote_resource_id: str = "",
        local_snapshot: dict[str, Any] | None = None,
        remote_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        conflict_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO resource_conflicts
                   (id, external_resource_id, local_resource_type, local_resource_id, remote_resource_id,
                    conflict_type, local_snapshot_json, remote_snapshot_json, resolution, resolved_by,
                    resolved_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)""",
                (
                    conflict_id,
                    external_resource_id,
                    local_resource_type,
                    local_resource_id,
                    remote_resource_id,
                    conflict_type,
                    json.dumps(local_snapshot or {}, ensure_ascii=False),
                    json.dumps(remote_snapshot or {}, ensure_ascii=False),
                    now,
                ),
            )
        return self.get_resource_conflict(conflict_id) or {}

    def get_resource_conflict(self, conflict_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM resource_conflicts WHERE id = ?", (conflict_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result["local_snapshot"] = json.loads(result.pop("local_snapshot_json"))
            result["remote_snapshot"] = json.loads(result.pop("remote_snapshot_json"))
            return result

    def list_resource_conflicts(self, resolution: str = "pending") -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM resource_conflicts WHERE resolution = ? ORDER BY created_at DESC", (resolution,)
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item["local_snapshot"] = json.loads(item.pop("local_snapshot_json"))
                item["remote_snapshot"] = json.loads(item.pop("remote_snapshot_json"))
                result.append(item)
            return result

    def add_outbox_event(self, aggregate_type: str, aggregate_id: str, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        event_id, now = str(uuid.uuid4()), utc_now()
        with self.connection() as connection:
            connection.execute(
                """INSERT INTO outbox_events
                   (id, aggregate_type, aggregate_id, event_type, payload_json, status, attempts,
                    next_attempt_at, last_error, created_at, processed_at)
                   VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, '', ?, NULL)""",
                (event_id, aggregate_type, aggregate_id, event_type, json.dumps(payload or {}, ensure_ascii=False), now, now),
            )
        return self.get_outbox_event(event_id) or {}

    def get_outbox_event(self, event_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM outbox_events WHERE id = ?", (event_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result["payload"] = json.loads(result.pop("payload_json"))
            return result

    def list_pending_outbox_events(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT * FROM outbox_events
                   WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?""",
                (limit,),
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item["payload"] = json.loads(item.pop("payload_json"))
                result.append(item)
            return result

    def mark_outbox_event(self, event_id: str, *, status: str, error: str = "", increment_attempt: bool = False) -> dict[str, Any] | None:
        now = utc_now()
        with self._lock, self.connection() as connection:
            if increment_attempt:
                connection.execute(
                    "UPDATE outbox_events SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?",
                    (status, error, event_id),
                )
            else:
                connection.execute("UPDATE outbox_events SET status = ?, last_error = ? WHERE id = ?", (status, error, event_id))
            if status in {"processed", "dead"}:
                connection.execute("UPDATE outbox_events SET processed_at = ? WHERE id = ?", (now, event_id))
        return self.get_outbox_event(event_id)
