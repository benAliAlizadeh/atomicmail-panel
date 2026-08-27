# AtomicMail Panel — Stage 1 Core (AM-01 → AM-08)

A conservative batch-registration core for Atomic Mail. It uses the official Atomic Mail AgentSkill CLI for registration and PoW rather than reimplementing or bypassing provider controls.

## What is implemented

- SQLite persistence with crash recovery
- Atomic Mail provider adapter using the official `@atomicmail/agent-skill` CLI
- one isolated credentials directory per inbox
- valid 5–21 character random usernames with duplicate prevention
- persistent batch jobs and items
- strictly sequential worker (`concurrency = 1`)
- configurable post-success cooldown
- retry with exponential backoff + jitter for transient failures
- 429/rate-limit cooldown and global temporary circuit breaker
- permanent circuit breaker on policy/abuse-protection responses
- automatic regeneration when a username is unavailable
- secret redaction in provider errors/audit logs
- pause / resume / cancel endpoints
- restart recovery for interrupted items

## Provider behavior

Atomic Mail's official documentation says `@atomicmail.ai` registrations use PoW and that separate credential directories should be used for multiple accounts. This project delegates that protocol to their official CLI.

Default runtime command:

```bash
npx -y --package=@atomicmail/agent-skill@0.3.26 atomicmail register --username <name>
```

The process receives `ATOMIC_MAIL_CREDENTIALS_DIR` pointing to a unique directory for that mailbox.

For production Docker, the same package is installed globally and the worker calls `atomicmail` directly.

## Run locally

Requirements: Node.js 22+ and network access to Atomic Mail/npm.

```bash
cp .env.example .env
set -a; source .env; set +a
npm start
```

PowerShell:

```powershell
$env:HOST="127.0.0.1"
$env:PORT="8787"
npm start
```

You do not need a local package install for this project itself; the default provider command invokes the pinned official AgentSkill through `npx`.

## Run with Docker

```bash
docker compose up -d --build
```

The compose file binds to `127.0.0.1:8787` intentionally because Stage 1 has no admin authentication yet.

## API

Health:

```bash
curl http://127.0.0.1:8787/health
```

Create 5 inboxes:

```bash
curl -X POST http://127.0.0.1:8787/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"count":5,"prefix":""}'
```

Optional prefix:

```json
{"count": 5, "prefix": "lab"}
```

List jobs:

```bash
curl http://127.0.0.1:8787/api/jobs
```

Job details:

```bash
curl http://127.0.0.1:8787/api/jobs/JOB_ID
```

Pause / resume / cancel:

```bash
curl -X POST http://127.0.0.1:8787/api/jobs/JOB_ID/pause
curl -X POST http://127.0.0.1:8787/api/jobs/JOB_ID/resume
curl -X POST http://127.0.0.1:8787/api/jobs/JOB_ID/cancel
```

Mailboxes:

```bash
curl http://127.0.0.1:8787/api/mailboxes
```

Circuit status/reset:

```bash
curl http://127.0.0.1:8787/api/system/circuit
curl -X POST http://127.0.0.1:8787/api/system/circuit/reset
```

Do not reset a permanent circuit until the provider response has been reviewed. It intentionally requires explicit operator action.

## Credentials and secrets

Per-inbox credentials are stored under:

```text
data/credentials/<username>/credentials.json
```

The project does **not** copy API keys or JWTs into SQLite. Provider output is redacted before it is written to audit logs.

Back up the `data/` directory securely. Replacing an Atomic Mail credential directory can destroy access to that inbox.

## Tests

```bash
npm test
npm run check
```

Tests use fake providers; they do not create live Atomic Mail inboxes.

## Next stage

AM-09 onward: production web dashboard, create-batch screen, live progress, mailbox management, CSV/JSON export, admin authentication, stronger secret-at-rest controls, and final Docker/live validation.
