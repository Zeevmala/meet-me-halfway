import re
import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.config import settings

structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        (
            structlog.processors.JSONRenderer()
            if settings.LOG_FORMAT == "json"
            else structlog.dev.ConsoleRenderer()
        ),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(20),
)

_SESSION_PATH_RE = re.compile(r"^/api/v1/sessions/([^/]+)")

logger = structlog.get_logger()


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: any) -> Response:  # type: ignore[override]
        request_id = str(uuid.uuid4())
        path = request.url.path

        bound = logger.bind(
            method=request.method,
            path=path,
            client_ip=request.client.host if request.client else "unknown",
            request_id=request_id,
        )

        m = _SESSION_PATH_RE.match(path)
        if m:
            bound = bound.bind(session_id=m.group(1))

        t0 = time.monotonic()
        response: Response = await call_next(request)
        latency_ms = round((time.monotonic() - t0) * 1000, 1)

        if path == "/health":
            return response

        status = response.status_code
        log_data = dict(status_code=status, latency_ms=latency_ms)

        if status < 400:
            bound.info("request", **log_data)
        elif status < 500:
            bound.warning("request", **log_data)
        else:
            bound.error("request", **log_data)

        return response
