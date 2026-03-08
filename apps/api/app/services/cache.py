"""
TTL-based in-memory cache for Google Places API responses.

Single-process, asyncio-safe (no locks needed — event loop is single-threaded).
In production, swap for Redis via the same interface.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any


@dataclass
class _Entry:
    value: Any
    expires_at: float


class TTLCache:
    """Simple in-memory cache with per-entry TTL expiry."""

    def __init__(self, ttl_seconds: int = 300) -> None:
        self._ttl = ttl_seconds
        self._store: dict[str, _Entry] = {}

    def get(self, key: str) -> Any | None:
        """Return cached value or None if missing / expired."""
        entry = self._store.get(key)
        if entry is None:
            return None
        if time.monotonic() > entry.expires_at:
            del self._store[key]
            return None
        return entry.value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = _Entry(value=value, expires_at=time.monotonic() + self._ttl)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def __len__(self) -> int:
        return len(self._store)

    def evict_expired(self) -> int:
        """Remove all expired entries; return count removed."""
        now = time.monotonic()
        expired = [k for k, e in self._store.items() if now > e.expires_at]
        for k in expired:
            del self._store[k]
        return len(expired)


# Module-level singleton — 5-min TTL matching Google Places freshness window
places_cache: TTLCache = TTLCache(ttl_seconds=300)
