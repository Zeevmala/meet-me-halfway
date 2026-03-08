"""
Webhook router tests — two layers:

1. HTTP layer — httpx.AsyncClient + ASGITransport with service/client mocked.
2. Unit layer — parse_incoming_message called directly.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from app.bot.whatsapp import parse_incoming_message
from app.config import settings
from app.dependencies import get_db
from app.models.schemas import SessionOut
from app.services import session_service

# ── Test constants ─────────────────────────────────────────────────────────────

TEST_APP_SECRET = "test-app-secret"
TEST_VERIFY_TOKEN = "test-verify-token"
TEST_PHONE = "15551234567"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_signature(body: bytes, secret: str = TEST_APP_SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _text_payload(phone: str, text: str) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [{"from": phone, "type": "text", "text": {"body": text}}]
                        }
                    }
                ]
            }
        ],
    }


def _location_payload(phone: str, lat: float, lng: float) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {
                                    "from": phone,
                                    "type": "location",
                                    "location": {
                                        "latitude": lat,
                                        "longitude": lng,
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
        ],
    }


def _mock_session_out() -> SessionOut:
    now = datetime.now(UTC)
    return SessionOut(
        session_id="550e8400-e29b-41d4-a716-446655440000",
        status="active",
        locale="en",
        created_at=now,
        expires_at=now + timedelta(hours=4),
        participant_count=0,
        max_participants=5,
    )


# ── HTTP layer tests ───────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_webhook_verification_valid(client):
    with patch.object(settings, "WHATSAPP_TOKEN", TEST_VERIFY_TOKEN):
        resp = await client.get(
            "/api/v1/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": TEST_VERIFY_TOKEN,
                "hub.challenge": "echo-me",
            },
        )
    assert resp.status_code == 200
    assert resp.text == "echo-me"


@pytest.mark.anyio
async def test_webhook_verification_invalid_token(client):
    with patch.object(settings, "WHATSAPP_TOKEN", TEST_VERIFY_TOKEN):
        resp = await client.get(
            "/api/v1/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": "wrong-token",
                "hub.challenge": "echo-me",
            },
        )
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_webhook_post_invalid_signature(client):
    with patch.object(settings, "WHATSAPP_APP_SECRET", TEST_APP_SECRET):
        body = json.dumps(_text_payload(TEST_PHONE, "hello")).encode()
        resp = await client.post(
            "/api/v1/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": "sha256=badsignature",
            },
        )
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_webhook_post_no_secret_skips_check(client, app):
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    with patch.object(settings, "WHATSAPP_APP_SECRET", ""):
        body = json.dumps(_text_payload(TEST_PHONE, "hello")).encode()
        resp = await client.post(
            "/api/v1/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    app.dependency_overrides.clear()
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_webhook_command_meetme_creates_session(client, app):
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    mock_create = AsyncMock(return_value=_mock_session_out())
    with (
        patch.object(settings, "WHATSAPP_APP_SECRET", ""),
        patch.object(session_service, "create_session", mock_create),
        patch("app.routers.webhook.get_client", return_value=None),
    ):
        body = json.dumps(_text_payload(TEST_PHONE, "meetme please")).encode()
        resp = await client.post(
            "/api/v1/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "session_created"
    mock_create.assert_called_once()


@pytest.mark.anyio
async def test_webhook_location_message_parsed(client, app):
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    with (
        patch.object(settings, "WHATSAPP_APP_SECRET", ""),
        patch("app.routers.webhook.get_client", return_value=None),
    ):
        body = json.dumps(_location_payload(TEST_PHONE, 32.08, 34.78)).encode()
        resp = await client.post(
            "/api/v1/webhook",
            content=body,
            headers={"Content-Type": "application/json"},
        )
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    assert resp.json()["status"] == "location_received"


@pytest.mark.anyio
async def test_webhook_post_valid_hmac_signature(client, app):
    """POST with correctly computed HMAC-SHA256 passes verification."""
    app.dependency_overrides[get_db] = lambda: AsyncMock()
    body = json.dumps(_text_payload(TEST_PHONE, "hello")).encode()
    signature = _make_signature(body, TEST_APP_SECRET)
    with (
        patch.object(settings, "WHATSAPP_APP_SECRET", TEST_APP_SECRET),
        patch("app.routers.webhook.get_client", return_value=None),
    ):
        resp = await client.post(
            "/api/v1/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": signature,
            },
        )
    app.dependency_overrides.clear()
    assert resp.status_code == 200


# ── Unit tests for parse_incoming_message ─────────────────────────────────────


def test_parse_incoming_text_message():
    payload = _text_payload(TEST_PHONE, "meetme now")
    msg = parse_incoming_message(payload)
    assert msg is not None
    assert msg.phone == TEST_PHONE
    assert msg.msg_type == "text"
    assert msg.text == "meetme now"
    assert msg.lat is None
    assert msg.lng is None


def test_parse_incoming_location_message():
    payload = _location_payload(TEST_PHONE, 32.08, 34.78)
    msg = parse_incoming_message(payload)
    assert msg is not None
    assert msg.phone == TEST_PHONE
    assert msg.msg_type == "location"
    assert msg.lat == pytest.approx(32.08)
    assert msg.lng == pytest.approx(34.78)
    assert msg.text is None
