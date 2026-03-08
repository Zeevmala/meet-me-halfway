from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.middleware.logging import RequestLoggingMiddleware  # configures structlog at import
from app.middleware.rate_limit import RateLimitMiddleware
from app.middleware.validation import UUIDValidationMiddleware
from app.routers import health, sessions, webhook
from app.services.firebase import initialize_firebase
from app.tasks.cleanup import start_cleanup_task, stop_cleanup_task


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    initialize_firebase()
    start_cleanup_task()
    yield
    stop_cleanup_task()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Meet Me Halfway API",
        version="0.1.0",
        description=(
            "Geodesic midpoint computation and ranked POI recommendations "
            "for 2-5 participants. WGS84 (EPSG:4326) throughout."
        ),
        lifespan=lifespan,
    )

    # ── Global exception handlers (RFC 7807) ─────────────────────────────

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "type": "about:blank",
                "title": "Validation Error",
                "status": 422,
                "detail": str(exc.errors()),
            },
            media_type="application/problem+json",
        )

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "type": "about:blank",
                "title": "Internal Server Error",
                "status": 500,
                "detail": "An unexpected error occurred.",
            },
            media_type="application/problem+json",
        )

    # ── Middleware (Starlette applies in reverse: last = outermost) ────────

    # 1. Innermost: CORS
    origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 2. Rate limiting: 60 req / 60 s per IP (spec §7)
    app.add_middleware(RateLimitMiddleware, calls=60, period=60)

    # 3. UUID path validation
    app.add_middleware(UUIDValidationMiddleware)

    # 4. Outermost: structured request logging
    app.add_middleware(RequestLoggingMiddleware)

    app.include_router(health.router)
    app.include_router(sessions.router)
    app.include_router(webhook.router)

    return app


app = create_app()
