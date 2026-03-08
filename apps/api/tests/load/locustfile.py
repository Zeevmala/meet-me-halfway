"""
Locust load test for Meet Me Halfway API.

Usage:
    # Full run (1000 users, 10/s ramp-up, 60s)
    locust -f tests/load/locustfile.py --headless -u 1000 -r 10 -t 60s --host http://localhost:8000

    # CI smoke run (10 users, 10s)
    locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 10s --host http://localhost:8000

Targets:
    /api/v1/sessions/{id}/midpoint  p95 < 800ms
    /api/v1/sessions                p95 < 200ms
"""

from __future__ import annotations

from locust import HttpUser, between, task


class MeetMeUser(HttpUser):
    wait_time = between(0.5, 2.0)

    def on_start(self) -> None:
        """Create a session and join with 2 participants."""
        resp = self.client.post(
            "/api/v1/sessions",
            json={"locale": "en", "max_participants": 5},
        )
        if resp.status_code != 201:
            self.session_id = None
            return

        data = resp.json()
        self.session_id: str | None = data["session_id"]

        # Join two participants
        self.participant_ids: list[str] = []
        for i, (lat, lng) in enumerate([(32.08, 34.78), (31.77, 35.21)]):
            join_resp = self.client.post(
                f"/api/v1/sessions/{self.session_id}/join",
                json={
                    "display_name": f"User-{i}",
                    "location": {"lat": lat, "lng": lng},
                },
            )
            if join_resp.status_code == 201:
                self.participant_ids.append(join_resp.json()["participant_id"])

    @task(3)
    def get_midpoint(self) -> None:
        if not self.session_id:
            return
        self.client.get(
            f"/api/v1/sessions/{self.session_id}/midpoint",
            name="/api/v1/sessions/[id]/midpoint",
        )

    @task(2)
    def get_session(self) -> None:
        if not self.session_id:
            return
        self.client.get(
            f"/api/v1/sessions/{self.session_id}",
            name="/api/v1/sessions/[id]",
        )

    @task(1)
    def update_location(self) -> None:
        if not self.session_id or not self.participant_ids:
            return
        pid = self.participant_ids[0]
        self.client.put(
            f"/api/v1/sessions/{self.session_id}/location",
            json={
                "participant_id": pid,
                "location": {"lat": 32.09, "lng": 34.79},
            },
            name="/api/v1/sessions/[id]/location",
        )

    @task(1)
    def create_session(self) -> None:
        self.client.post(
            "/api/v1/sessions",
            json={"locale": "en", "max_participants": 5},
            name="/api/v1/sessions",
        )
