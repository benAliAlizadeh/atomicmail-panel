# AtomicMail Panel — Production-Ready Web Operator (AM-01 → AM-19)

A conservative Atomic Mail batch-registration panel. Registration remains strictly sequential and delegates Proof-of-Work and account registration to the official Atomic Mail AgentSkill CLI. The panel does not attempt to bypass provider controls.

## Included

- persistent SQLite jobs with restart reconciliation
- isolated credential directory per inbox
- crash-safe credential reuse to avoid duplicate signup after a DB-commit interruption
- valid random usernames with duplicate prevention
- strictly sequential worker (`concurrency = 1`)
- post-success cooldown, retry/backoff+jitter, rate-limit cooldown
- temporary and permanent circuit breakers
- automatic username regeneration on conflicts
- controlled shutdown: active provider process is stopped and the item is safely returned to pending
- job counter/state reconciliation after restart
- web dashboard and create-batch form
- live job progress with provider phase, heartbeat, elapsed time, rolling ETA, pause/resume/cancel
- searchable mailbox list with copy and pagination
- CSV and JSON export
- optional admin session authentication
- HttpOnly/SameSite session cookie, CSRF protection, login attempt throttling
- restrictive browser security headers/CSP
- no credential file path, API key or JWT exposure through mailbox APIs
- hardened Docker defaults: non-root, read-only root filesystem, dropped capabilities, healthcheck and graceful stop

## Local run on Windows / PowerShell

Requirements: Node.js 22.9+.

```powershell
npm.cmd run verify
npm.cmd start
```

Open:

```text
http://127.0.0.1:8787
```

`npm start` automatically reads `.env` when it exists.

## Enable admin login

Copy `.env.example` to `.env`, then set a 12+ character password:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
```

Restart the app. The browser will show the login screen.

When the panel remains strictly on `127.0.0.1`, authentication can be left disabled for local-only operation. Before exposing it on a LAN, public interface, tunnel, or reverse proxy, enable `ADMIN_PASSWORD` and put the panel behind HTTPS. Set `ADMIN_COOKIE_SECURE=true` only when the browser actually reaches it over HTTPS.

## Windows npx compatibility

On Windows, `npm`/`npx` are command shims (`.cmd`) rather than native executables. The provider automatically resolves the installed npm `npx-cli.js` beside `node.exe` and launches it through Node directly. This keeps `shell: false`, avoids command-shell quoting, and prevents `spawn npx ENOENT` on standard Node.js MSI/winget installations.

If the npm files beside `node.exe` are missing, the job now fails with an explicit local configuration error before contacting Atomic Mail.

## Atomic Mail registration mode

The current AgentSkill registration flow requires an operator-selected `--watch` mode. This panel creates and stores inboxes but does not schedule inbox polling, so the default is:

```env
ATOMICMAIL_WATCH_MODE=on-demand
```

The generated registration command is equivalent to:

```bash
atomicmail register --username <name> --watch on-demand
```

`scheduled` is accepted through configuration for compatibility, but this panel does not create the external agent scheduler described by Atomic Mail. Do not select `scheduled` unless you separately implement and own that scheduler.

Each inbox receives a separate credential directory under:

```text
data/credentials/<username>/
```

Do not delete or overwrite these directories. `credentials.json` contains the API key used to access the inbox; session/capability JWTs are short-lived bearer credentials.

### Important: agent inboxes are not human webmail accounts

This panel uses Atomic Mail's **agent** registration path and creates `@atomicmail.ai` inboxes. That path authenticates with an API key/JWT credential model and does **not** create a human webmail password or a 12-word recovery seed phrase. Password + BIP39 seed phrases belong to Atomic Mail's separate human-facing `@atomicmail.io` account flow. The panel therefore does not ask for a batch password because the agent registration API has no password field to send.

## Create emails

Use **Create emails** in the web panel, enter a count and optional prefix, then create the batch. The server reserves final usernames and the worker processes them one by one.

A policy/abuse-protection response opens a permanent circuit and pauses the affected job. The panel never automatically resets a permanent circuit; an operator must review the provider response and explicitly reset it from **System**.

## Restart and shutdown safety

On startup the database is reconciled before work resumes:

- an interrupted `running` item is returned to `pending`
- its interrupted attempt is not counted as a provider failure
- cancelled jobs remain cancelled
- job success/failure counters are recomputed from item state
- inconsistent terminal jobs with an in-flight item are reopened for recovery

On SIGINT/SIGTERM the panel stops accepting new work, aborts the active registration process, returns that item to `pending`, waits for the worker to become idle, checkpoints SQLite WAL, and exits. Docker uses a matching stop grace period.

If the process is force-killed before graceful shutdown finishes, startup recovery handles the remaining `running` item.

## Exports

The Mailboxes page exports the current search as CSV or JSON. Provider credentials and credential paths are intentionally excluded. Exports are capped by `EXPORT_MAX_ROWS`.

## Provider command

Default local command:

```bash
npx -y --package=@atomicmail/agent-skill@0.3.26 atomicmail register --username <name> --watch on-demand
```

Docker installs the same version globally for reproducible builds.

## API authentication

When `ADMIN_PASSWORD` is enabled, `/api/*` endpoints require the admin session except `/api/auth/status` and `/api/auth/login`. State-changing requests also require the per-session CSRF token used automatically by the web UI.

`GET /health` stays intentionally minimal:

```json
{"ok":true}
```

## Tests

```powershell
npm.cmd run verify
```

This runs syntax checks plus the full Node test suite. Automated tests do not create live Atomic Mail inboxes.

## Docker

Build and run:

```bash
docker compose up -d --build
docker compose ps
```

The default compose mapping is loopback-only:

```text
127.0.0.1:8787:8787
```

Production hardening enabled by default:

- container init process
- non-root application user
- read-only root filesystem
- writable persistent `/app/data` only
- tmpfs `/tmp`
- all Linux capabilities dropped
- `no-new-privileges`
- PID limit
- application/container healthcheck
- graceful stop window

Before exposing the service beyond localhost:

1. Set a strong `ADMIN_PASSWORD`.
2. Terminate TLS in a reverse proxy you control.
3. Set `ADMIN_COOKIE_SECURE=true`.
4. Keep the application port private/loopback where possible.
5. Back up the entire `data/` directory securely; it contains both SQLite state and mailbox credentials.

## Verification after deployment

```bash
curl --fail http://127.0.0.1:8787/health
docker compose ps
```

The service should report healthy before you use **Create emails**.

## Live validation status

AM-18 is complete after the first operator-approved real `@atomicmail.ai` inbox registration succeeded and appeared in the panel. AM-19 adds live phase/heartbeat/elapsed/ETA visibility so long sequential batches no longer look hung.
