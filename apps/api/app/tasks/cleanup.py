"""
Background task: periodically expire sessions whose expires_at has passed.
Runs every 5 minutes inside the FastAPI lifespan event loop.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import update

from app.models.db import Session, async_session
from app.services.cache import places_cache

logger = logging.getLogger(__name__)

_INTERVAL_SECONDS = 300  # 5 minutes


async def expire_sessions() -> int:
    """
    Set status='expired' on all sessions past their expires_at timestamp.

    Returns:
        Number of sessions expired.
    """
    async with async_session() as db, db.begin():
        result = await db.execute(
            update(Session)
            .where(
                Session.status == "active",
                Session.expires_at < datetime.now(UTC),
            )
            .values(status="expired")
        )
        count: int = result.rowcount  # type: ignore[assignment]

    if count:
        logger.info("Session cleanup: expired %d sessions", count)

    # Opportunistically evict stale Places cache entries
    evicted = places_cache.evict_expired()
    if evicted:
        logger.debug("Places cache: evicted %d stale entries", evicted)

    return count


async def _cleanup_loop() -> None:
    """Infinite loop — runs until task is cancelled on shutdown."""
    while True:
        await asyncio.sleep(_INTERVAL_SECONDS)
        try:
            await expire_sessions()
        except Exception:
            logger.exception("Session cleanup task error")


_cleanup_task: asyncio.Task[None] | None = None


def start_cleanup_task() -> None:
    """Schedule the cleanup loop as a background asyncio task."""
    global _cleanup_task
    _cleanup_task = asyncio.create_task(_cleanup_loop(), name="session-cleanup")
    logger.info("Session cleanup task started (interval=%ds)", _INTERVAL_SECONDS)


def stop_cleanup_task() -> None:
    """Cancel the cleanup task gracefully on shutdown."""
    global _cleanup_task
    if _cleanup_task and not _cleanup_task.done():
        _cleanup_task.cancel()
        logger.info("Session cleanup task stopped")
    _cleanup_task = None
