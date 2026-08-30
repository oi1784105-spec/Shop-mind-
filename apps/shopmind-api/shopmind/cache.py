from __future__ import annotations

import json
import threading
import time
from typing import Any, Protocol

from redis import Redis
from redis.exceptions import RedisError


class CacheUnavailable(RuntimeError):
    pass


class SessionCache(Protocol):
    def ping(self) -> bool: ...
    def set_json(self, key: str, value: Any, ttl: int) -> None: ...
    def get_json(self, key: str) -> Any | None: ...
    def delete(self, key: str) -> None: ...


class RedisSessionCache:
    def __init__(self, url: str):
        self.client = Redis.from_url(url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)

    def ping(self) -> bool:
        try:
            return bool(self.client.ping())
        except RedisError as exc:
            raise CacheUnavailable("Redis session cache is unavailable") from exc

    def set_json(self, key: str, value: Any, ttl: int) -> None:
        try:
            self.client.setex(f"shopmind:{key}", ttl, json.dumps(value, ensure_ascii=False))
        except RedisError as exc:
            raise CacheUnavailable("Redis session cache is unavailable") from exc

    def get_json(self, key: str) -> Any | None:
        try:
            value = self.client.get(f"shopmind:{key}")
            return json.loads(value) if value else None
        except RedisError as exc:
            raise CacheUnavailable("Redis session cache is unavailable") from exc

    def delete(self, key: str) -> None:
        try:
            self.client.delete(f"shopmind:{key}")
        except RedisError as exc:
            raise CacheUnavailable("Redis session cache is unavailable") from exc


class MemorySessionCache:
    """Test-only cache with Redis-compatible expiry behavior."""

    def __init__(self):
        self._items: dict[str, tuple[float, Any]] = {}
        self._lock = threading.RLock()

    def ping(self) -> bool:
        return True

    def set_json(self, key: str, value: Any, ttl: int) -> None:
        with self._lock:
            self._items[key] = (time.time() + ttl, value)

    def get_json(self, key: str) -> Any | None:
        with self._lock:
            item = self._items.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at <= time.time():
                self._items.pop(key, None)
                return None
            return value

    def delete(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

