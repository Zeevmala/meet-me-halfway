import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

_SESSION_PATH_RE = re.compile(r"^/api/v1/sessions/([^/]+)")


class UUIDValidationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: any) -> Response:  # type: ignore[override]
        m = _SESSION_PATH_RE.match(request.url.path)
        if m:
            try:
                uuid.UUID(m.group(1))
            except ValueError:
                return JSONResponse(
                    status_code=422,
                    content={"detail": "Invalid session_id: must be a UUID"},
                )
        return await call_next(request)
