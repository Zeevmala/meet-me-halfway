async def test_health_returns_200(client):
    response = await client.get("/health")
    assert response.status_code == 200


async def test_health_payload(client):
    data = (await client.get("/health")).json()
    assert data["status"] == "ok"
    assert "version" in data


async def test_health_cors_header(client):
    response = await client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" in response.headers
