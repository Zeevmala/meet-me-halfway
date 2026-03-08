"""
WhatsApp Cloud API client.

Handles outbound messaging and inbound payload parsing.
Does NOT contain routing logic — see app.routers.webhook for that.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.config import settings

_GRAPH_URL = "https://graph.facebook.com/v17.0"


@dataclass
class IncomingMessage:
    phone: str
    msg_type: str  # "text" | "location" | other Cloud API types
    text: str | None = None
    lat: float | None = None
    lng: float | None = None


class WhatsAppClient:
    def __init__(self, token: str, phone_number_id: str) -> None:
        self._pid = phone_number_id
        self._http = httpx.AsyncClient(
            base_url=_GRAPH_URL,
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )

    async def send_text(self, phone: str, message: str) -> None:
        await self._http.post(
            f"/{self._pid}/messages",
            json={
                "messaging_product": "whatsapp",
                "to": phone,
                "type": "text",
                "text": {"body": message},
            },
        )

    async def send_interactive_button(self, phone: str, body: str, buttons: list[dict]) -> None:
        await self._http.post(
            f"/{self._pid}/messages",
            json={
                "messaging_product": "whatsapp",
                "to": phone,
                "type": "interactive",
                "interactive": {
                    "type": "button",
                    "body": {"text": body},
                    "action": {"buttons": buttons},
                },
            },
        )

    @staticmethod
    def verify_webhook(token: str, challenge: str) -> str | None:
        """Return challenge if token matches WHATSAPP_TOKEN, else None."""
        if token == settings.WHATSAPP_TOKEN:
            return challenge
        return None


def parse_incoming_message(payload: dict) -> IncomingMessage | None:
    """Extract the first message from a WhatsApp Cloud API webhook payload."""
    try:
        messages = payload["entry"][0]["changes"][0]["value"].get("messages") or []
        if not messages:
            return None
        msg = messages[0]
        phone: str = msg["from"]
        msg_type: str = msg["type"]

        if msg_type == "text":
            return IncomingMessage(
                phone=phone,
                msg_type="text",
                text=msg["text"]["body"],
            )
        if msg_type == "location":
            loc = msg["location"]
            return IncomingMessage(
                phone=phone,
                msg_type="location",
                lat=float(loc["latitude"]),
                lng=float(loc["longitude"]),
            )
        return IncomingMessage(phone=phone, msg_type=msg_type)
    except (KeyError, IndexError, TypeError):
        return None


# ── Module-level client factory ────────────────────────────────────────────────

_client: WhatsAppClient | None = None


def get_client() -> WhatsAppClient | None:
    """Return a shared WhatsAppClient, or None if credentials are not configured."""
    global _client
    if _client is None:
        token = settings.WHATSAPP_TOKEN
        pid = settings.WHATSAPP_PHONE_NUMBER_ID
        if token and pid:
            _client = WhatsAppClient(token=token, phone_number_id=pid)
    return _client
