"""
WhatsApp webhook router — prefix /api/v1/webhook.

GET  /api/v1/webhook  — hub subscription verification
POST /api/v1/webhook  — incoming message handler (HMAC-verified)
"""

from __future__ import annotations

import hashlib
import hmac
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot import messages
from app.bot.whatsapp import get_client, parse_incoming_message
from app.config import settings
from app.dependencies import get_db
from app.models.schemas import CreateSessionRequest
from app.services import session_service

router = APIRouter(prefix="/api/v1/webhook", tags=["webhook"])


# ── GET: hub verification ──────────────────────────────────────────────────────


@router.get("", response_class=PlainTextResponse)
async def verify_webhook(
    hub_mode: str | None = Query(None, alias="hub.mode"),
    hub_verify_token: str | None = Query(None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(None, alias="hub.challenge"),
) -> str:
    """WhatsApp hub subscription verification handshake."""
    if hub_mode == "subscribe" and hub_verify_token == settings.WHATSAPP_TOKEN:
        return hub_challenge or ""
    return PlainTextResponse("Forbidden", status_code=403)  # type: ignore[return-value]


# ── POST: incoming message handler ────────────────────────────────────────────


@router.post("")
async def receive_message(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Process an incoming WhatsApp message after HMAC signature verification."""
    raw_body = await request.body()

    # HMAC-SHA256 verification — skipped in dev mode (empty secret)
    secret = settings.WHATSAPP_APP_SECRET
    if secret:
        sig_header = request.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig_header):
            raise HTTPException(status_code=403, detail="Invalid signature")

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return {"status": "ignored"}

    msg = parse_incoming_message(payload)
    if msg is None:
        return {"status": "ignored"}

    wa_client = get_client()

    # ── Command: text containing "meetme" or "halfway" → create session ────────
    if msg.msg_type == "text" and msg.text:
        lower = msg.text.lower()
        if "meetme" in lower or "halfway" in lower:
            session = await session_service.create_session(db, CreateSessionRequest(locale="en"))
            link = f"{settings.APP_DOMAIN}/s/{session.session_id}"
            if wa_client:
                await wa_client.send_text(msg.phone, messages.session_created(link, locale="en"))
            return {"status": "session_created", "session_id": session.session_id}

    # ── Location message → best-effort join by phone hash ─────────────────────
    if msg.msg_type == "location" and msg.lat is not None and msg.lng is not None:
        # Full phone-hash session lookup deferred to Sprint 6 (requires session
        # index on participants.phone_hash). Acknowledge receipt for now.
        return {"status": "location_received"}

    return {"status": "received"}
