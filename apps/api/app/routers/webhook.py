"""
WhatsApp webhook router — prefix /api/v1/webhook.

GET  /api/v1/webhook  — hub subscription verification
POST /api/v1/webhook  — incoming message handler (HMAC-verified)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging

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
logger = logging.getLogger(__name__)


def _phone_hash(phone: str) -> str:
    """SHA-256 hash of normalized phone number for privacy-preserving lookup."""
    return hashlib.sha256(phone.strip().encode()).hexdigest()


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
            link = f"{settings.APP_DOMAIN}?session={session.session_id}"
            ph = _phone_hash(msg.phone)
            await session_service.register_phone_session(db, ph, session.session_id)

            if wa_client:
                await wa_client.send_text(msg.phone, messages.session_created(link, locale="en"))
                # Send interactive location request — opens native picker
                await wa_client.send_location_request(
                    msg.phone, messages.location_request(locale="en")
                )

            return {"status": "session_created", "session_id": session.session_id}

    # ── Location message → auto-join by phone hash ─────────────────────────────
    if msg.msg_type == "location" and msg.lat is not None and msg.lng is not None:
        ph = _phone_hash(msg.phone)
        session_id = await session_service.find_session_by_phone(db, ph)

        if session_id is None:
            if wa_client:
                await wa_client.send_text(msg.phone, messages.no_active_session(locale="en"))
            return {"status": "no_session"}

        # Use last 4 digits of phone as display name fallback
        display_name = f"WhatsApp {msg.phone[-4:]}"

        try:
            participant_id, is_new = await session_service.join_or_update_by_phone(
                db, session_id, ph, msg.lat, msg.lng, display_name
            )
        except HTTPException as exc:
            if wa_client and exc.status_code == 409:
                await wa_client.send_text(msg.phone, "Session is full.")
            return {"status": "error", "detail": str(exc.detail)}

        if wa_client:
            if is_new:
                await wa_client.send_text(
                    msg.phone,
                    messages.location_received(display_name, locale="en"),
                )

            # Check if enough participants have location for midpoint
            count = await session_service.get_participant_count_with_location(db, session_id)
            if count >= 2:
                try:
                    midpoint_data = await session_service.get_midpoint(db, session_id)
                    top_venue = midpoint_data.venues[0] if midpoint_data.venues else None
                    link = f"{settings.APP_DOMAIN}?session={session_id}"

                    if top_venue:
                        await wa_client.send_text(
                            msg.phone,
                            messages.midpoint_ready(top_venue.name, link, locale="en"),
                        )
                        # Send the midpoint as a tappable location pin
                        await wa_client.send_location(
                            msg.phone,
                            midpoint_data.centroid.lat,
                            midpoint_data.centroid.lng,
                            "Meeting Point",
                            f"Near {top_venue.name}",
                        )
                except Exception:
                    logger.exception("Failed to compute/send midpoint for session %s", session_id)
            else:
                await wa_client.send_text(
                    msg.phone,
                    messages.waiting_for_others(have=count, need=2, locale="en"),
                )

        return {
            "status": "location_joined",
            "session_id": session_id,
            "participant_id": participant_id,
        }

    return {"status": "received"}
