# AtomicMail Panel — Web Operator Stage (AM-01 → AM-14)

A conservative Atomic Mail batch-registration panel. Registration stays sequential and delegates provider PoW/registration behavior to the configured Atomic Mail AgentSkill CLI rather than attempting to bypass provider controls.

## Included

- persistent SQLite jobs and restart recovery
- isolated credential directory per inbox
- valid random usernames with duplicate prevention
- strictly sequential worker (`concurrency = 1`)
- post-success cooldown, retry/backoff+jitter, rate-limit cooldown
- temporary and permanent circuit breakers
- automatic username regeneration on conflicts
- web dashboard and create-batch form
- live job progress with pause/resume/cancel
- searchable mailbox list with copy and pagination
- CSV and JSON export
- optional admin session authentication
- HttpOnly/SameSite session cookie, CSRF protection, login attempt throttling
- restrictive browser security headers/CSP
- no credential file path, API key or JWT exposure through mailbox APIs

## Run on Windows / PowerShell

Requirements: Node.js 22.9+.

```powershell
npm.cmd start
```

Open:

```text
http://127.0.0.1:8787
```

`npm start` now automatically reads `.env` when it exists.

## Enable admin login

Copy `.env.example` to `.env`, then set a 12+ character password:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
```

Restart the app. The browser will show the login screen.

When the panel remains strictly on `127.0.0.1`, authentication can be left disabled for local-only operation. Before exposing it on a LAN, public interface, tunnel, or reverse proxy, enable `ADMIN_PASSWORD` and put the panel behind HTTPS. Set `ADMIN_COOKIE_SECURE=true` only when the browser actually reaches it over HTTPS.

## Create emails

Use **Create emails** in the web panel, enter a count and optional prefix, then create the batch. The server reserves final usernames and the worker processes them one by one.

A policy/abuse-protection response opens a permanent circuit and pauses the affected job. The panel does not automatically reset a permanent circuit; an operator must review the provider response and explicitly reset it from **System**.

## Exports

The Mailboxes page exports the current search as CSV or JSON. Provider credentials and credential paths are intentionally excluded. Exports are capped by `EXPORT_MAX_ROWS` to avoid accidental oversized responses.

## Provider command

Default local command:

```bash
npx -y --package=@atomicmail/agent-skill@0.3.26 atomicmail register --username <name>
```

Each inbox receives a separate `ATOMIC_MAIL_CREDENTIALS_DIR` under:

```text
data/credentials/<username>/
```

Do not delete or overwrite these directories; they contain access credentials for the inboxes.

## API authentication

When `ADMIN_PASSWORD` is enabled, `/api/*` endpoints require the admin session except `/api/auth/status` and `/api/auth/login`. State-changing requests also require the per-session CSRF token used automatically by the web UI.

`GET /health` stays intentionally minimal:

```json
{"ok":true}
```

## Tests

```powershell
npm.cmd test
npm.cmd run check
```

Tests do not create live Atomic Mail inboxes.

## Docker

```bash
docker compose up -d --build
```

The default compose mapping remains loopback-only (`127.0.0.1:8787`). For non-loopback deployment, enable admin authentication and HTTPS before changing that binding.

## Next

AM-15 → AM-18: recovery edge-case hardening, broader regression tests, production/TLS deployment polish, and a small operator-approved live registration validation.
