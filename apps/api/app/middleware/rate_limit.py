"""
Sliding-window rate limiter middleware: 60 requests / 60 seconds per client IP.
Uses an in-memory deque per IP — single-process only.
For multi-instance Cloud Run, swap to Redis-backed sliding window.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Any

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp


class RateLimitMiddleware(BaseHTTPMiddleware):
    """60 req / 60 s per IP. Returns 429 with Retry-After header on breach."""

    def __init__(self, app: ASGIApp, calls: int = 60, period: int = 60) -> None:
        super().__init__(app)
        self._calls = calls
        self._period = period
        # deque of monotonic timestamps per IP
        self._windows: dict[str, deque[float]] = defaultdict(deque)

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        # Skip rate limiting for health checks to avoid false alerts
        if request.url.path == "/health":
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window = self._windows[ip]

        # Evict timestamps outside the current window
        cutoff = now - self._period
        while window and window[0] <= cutoff:
            window.popleft()

        if len(window) >= self._calls:
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again later."},
                headers={"Retry-After": str(self._period)},
            )

        window.append(now)
        return await call_next(request)
