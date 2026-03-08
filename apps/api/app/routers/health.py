import logging

from fastapi import APIRouter

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/health")
async def health_check() -> dict:
    return {"status": "ok", "version": "0.1.0"}


@router.get("/api/v1/health")
async def health_check_detailed() -> dict:
    from app.services.firebase import _firebase_ready

    # DB connectivity check
    db_status = "disconnected"
    try:
        from sqlalchemy import text

        from app.models.db import async_session

        async with async_session() as session:
            await session.execute(text("SELECT 1"))
        db_status = "connected"
    except Exception as exc:
        logger.warning("Health check DB probe failed: %s", exc)

    firebase_status = "ready" if _firebase_ready else "disabled"

    return {
        "status": "ok",
        "version": "0.1.0",
        "db": db_status,
        "firebase": firebase_status,
    }
