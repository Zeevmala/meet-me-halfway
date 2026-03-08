"""
Tests for the session cleanup background task.

Uses the FakeDB pattern from test_sessions.py to test expire_sessions()
without a real database connection.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_mock_result(rowcount: int) -> MagicMock:
    result = MagicMock()
    result.rowcount = rowcount
    return result


# ── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_expire_sessions_marks_expired():
    """expire_sessions() sets status='expired' on past-due sessions."""
    mock_result = _make_mock_result(rowcount=3)
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)

    mock_ctx = AsyncMock()
    mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
    mock_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_begin = AsyncMock()
    mock_begin.__aenter__ = AsyncMock(return_value=None)
    mock_begin.__aexit__ = AsyncMock(return_value=False)
    mock_session.begin = MagicMock(return_value=mock_begin)

    with (
        patch("app.tasks.cleanup.async_session", return_value=mock_ctx),
        patch("app.tasks.cleanup.places_cache") as mock_cache,
    ):
        mock_cache.evict_expired.return_value = 0
        from app.tasks.cleanup import expire_sessions

        count = await expire_sessions()

    assert count == 3
    mock_session.execute.assert_awaited_once()


@pytest.mark.anyio
async def test_expire_sessions_active_untouched():
    """When no sessions are expired, rowcount is 0."""
    mock_result = _make_mock_result(rowcount=0)
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)

    mock_ctx = AsyncMock()
    mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
    mock_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_begin = AsyncMock()
    mock_begin.__aenter__ = AsyncMock(return_value=None)
    mock_begin.__aexit__ = AsyncMock(return_value=False)
    mock_session.begin = MagicMock(return_value=mock_begin)

    with (
        patch("app.tasks.cleanup.async_session", return_value=mock_ctx),
        patch("app.tasks.cleanup.places_cache") as mock_cache,
    ):
        mock_cache.evict_expired.return_value = 0
        from app.tasks.cleanup import expire_sessions

        count = await expire_sessions()

    assert count == 0


@pytest.mark.anyio
async def test_expire_sessions_evicts_cache():
    """expire_sessions() also evicts stale Places cache entries."""
    mock_result = _make_mock_result(rowcount=0)
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_result)

    mock_ctx = AsyncMock()
    mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
    mock_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_begin = AsyncMock()
    mock_begin.__aenter__ = AsyncMock(return_value=None)
    mock_begin.__aexit__ = AsyncMock(return_value=False)
    mock_session.begin = MagicMock(return_value=mock_begin)

    with (
        patch("app.tasks.cleanup.async_session", return_value=mock_ctx),
        patch("app.tasks.cleanup.places_cache") as mock_cache,
    ):
        mock_cache.evict_expired.return_value = 5
        from app.tasks.cleanup import expire_sessions

        await expire_sessions()

    mock_cache.evict_expired.assert_called_once()
