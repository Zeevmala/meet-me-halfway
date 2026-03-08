from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.db import async_session


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session, session.begin():
        yield session
