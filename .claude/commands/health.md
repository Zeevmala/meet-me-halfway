---
description: Check Docker, all services, API responsiveness, and optionally create a test session
allowed-tools: Bash, Read
---

# Dev Environment Health Check

Run each check below in order. Report results as a checklist. Stop early and advise the user if Docker is not running.

## 1. Docker Desktop
Run `docker info` (timeout 5s). If it fails, tell the user to start Docker Desktop and stop here.

## 2. Container status
Run `docker compose ps` from the project root. Verify all 3 services are running:
- **db** (postgis) — should be healthy
- **api** (uvicorn) — should be up
- **web** (vite) — should be up

If any are missing, run `docker compose up -d --build` and wait for them.

## 3. API responsiveness
Run `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health` (timeout 5s).
Expected: 200. If not, check `docker compose logs api --tail 20` for errors.

## 4. Web server responsiveness
Run `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` (timeout 5s).
Expected: 200. If not, check `docker compose logs web --tail 20` for errors.

## 5. Database connectivity
Run `curl -s http://localhost:8000/health` and check the JSON response for database status.

## 6. Create test session (if requested with "fresh" argument)
If the user passed "fresh" as an argument ($ARGUMENTS contains "fresh"):
1. Create session: `POST /api/v1/sessions` with `{"locale":"en","max_participants":5}`
2. Join Ziv (Tel Aviv): `POST /sessions/{id}/join` with `{"display_name":"Ziv","location":{"lat":32.0853,"lng":34.7818}}`
3. Join Dana (Jerusalem): `POST /sessions/{id}/join` with `{"display_name":"Dana","location":{"lat":31.7683,"lng":35.2137}}`
4. Verify midpoint: `GET /sessions/{id}/midpoint`
5. Print the session URL: `http://localhost:5173/?session={id}`

## Output format
```
Dev Health Check
================
Docker Desktop:  OK / FAIL
Containers (3):  OK (db, api, web) / FAIL (missing: ...)
API (8000):      OK (200) / FAIL (status or unreachable)
Web (5173):      OK (200) / FAIL (status or unreachable)
Database:        OK / FAIL
-------------------------------------------------
Test session:    http://localhost:5173/?session=...  (only if "fresh")
```
