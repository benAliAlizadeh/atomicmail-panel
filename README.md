# AtomicMail Panel — Production-Ready Web Operator (AM-01 → AM-36)

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
- responsive operator UX with end-to-end stale read cancellation, adaptive non-overlapping polling and persistent progress feedback for slow operations
- live job progress with provider phase, heartbeat, elapsed time, rolling ETA, pause/resume/cancel
- searchable mailbox list with copy and pagination
- CSV and JSON export
- optional admin session authentication
- HttpOnly/SameSite session cookie, CSRF protection, login attempt throttling
- restrictive browser security headers/CSP
- no credential file path, API key or JWT exposure through mailbox APIs
- hardened Docker defaults: non-root, read-only root filesystem, dropped capabilities, healthcheck and graceful stop
- AES-256-GCM permanent credential vault; no readable API-key JSON remains under `data/credentials/`
- separately stored encryption key with portable key fingerprint
- automatic authenticated encrypted backups with SQLite integrity verification and offline restore
- Windows NTFS ACL / POSIX permission hardening with UI status
- on-demand Webmail for each `@atomicmail.ai` inbox through Atomic Mail JMAP
- Inbox list with sender, subject, preview, unread state and attachment indicator
- safe plain-text message reader with extracted HTTP/HTTPS links
- Compose and Reply through the official AgentSkill JMAP send/reply flows
- Inbox/Sent tabs, provider-side search and position pagination
- mark read/unread, Archive, safe move-to-Trash and conservative per-mailbox auto-refresh
- safe attachment upload/download through the AgentSkill JMAP blob flow
- verification-code and verification-link helpers without executing message HTML
- encrypted per-job destination-account password vault with CSRF-protected reveal/copy and explicit sensitive export
- manual Cloudflare Focus Mode for selected AtomicMail inboxes
- unique random 20-character password per Cloudflare account, encrypted with account-bound AES-256-GCM
- durable Signup Done / Verification Received / Verified progress with duplicate prevention and restart resume
- on-demand trusted Cloudflare verification-email detection with strict HTTPS/hostname validation
- explicit password/link reveal and sensitive export; normal APIs, logs, audit, and ordinary exports stay secret-free

## Local run on Windows / PowerShell

Requirements: Node.js 22.9+.

If the standard Windows install exists but this PowerShell session cannot find `node`/`npm`, activate it for the current session first:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

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

This panel uses Atomic Mail's **agent** registration path and creates `@atomicmail.ai` inboxes. That path authenticates with an API key/JWT credential model and does **not** create a human webmail password or a 12-word recovery seed phrase. Password + BIP39 seed phrases belong to Atomic Mail's separate human-facing `@atomicmail.io` account flow.

The optional **Destination account password** on the Create page is deliberately separate: it is an encrypted operator vault value shared by every mailbox in that job for use at destination services. It is never sent to Atomic Mail and is not an Atomic Mail credential.

## Create emails

Use **Create emails** in the web panel, enter a count and optional prefix, then create the batch. The server reserves final usernames and the worker processes them one by one.

A policy/abuse-protection response opens a permanent circuit and pauses the affected job. The panel never automatically resets a permanent circuit; an operator must review the provider response and explicitly reset it from **System**.

## Manual Cloudflare account assistant

The current Cloudflare workflow is intentionally simple and does not use Playwright, a paired runner, or browser automation.

1. Open **Mailboxes**, select up to 100 unused inboxes, and choose **Create Cloudflare batch**.
2. The panel generates a different 20-character password for every email and encrypts it at rest.
3. In **Cloudflare Accounts → Focus Mode**, copy the current email and password, then choose **Open Cloudflare Signup**.
4. Complete signup yourself in the official Cloudflare page and return to choose **Signup Done**. This locks the password.
5. Choose **Check Inbox**. The panel checks only that Atomic Mail inbox and only messages received after Signup Done.
6. When a trusted Cloudflare message is found, use **Open Verification Link** or **Copy Verification Link**.
7. After Cloudflare shows the address as verified, choose **Mark Verified & Next**.

Focus Mode resumes from the first unfinished record after a restart. An email already present in `cloudflare_accounts` can never be selected again; the Mailboxes page shows its saved status and verification date. Password regeneration is allowed only before Signup Done.

Normal account/list APIs never return passwords or verification URLs. Reveal, copy, and the separate `Email,Password,Status` CSV use authenticated POST actions with `Cache-Control: no-store`; audit records contain the action but not the secret. The SQLite columns holding account passwords and verification URLs contain only account-bound AES-256-GCM ciphertext, so the existing encrypted backup/restore pipeline includes them automatically.

## Retired browser-runner workflow (historical reference)

The runner-era implementation is retained only as dormant migration compatibility for old databases. It is not started by the application, its pairing/task endpoints return HTTP 410, and it has no main UI or npm command. Do not follow the historical instructions below for new batches.

<details>
<summary>Historical runner design (inactive)</summary>

Cloudflare onboarding is deliberately operator-assisted. The panel and runner automate preparation, inbox polling and safe verification, but a human must click every Cloudflare **Create account** submit control and solve every challenge shown by Cloudflare. The implementation does not use stealth browser patches, rotating proxies, CAPTCHA services or retry storms.

1. Open **Mailboxes**, select up to 100 eligible inboxes, and choose **Create Cloudflare job**.
2. Choose a generated 24-character shared password or provide a 12–128 byte shared password.
3. Open **Cloudflare Accounts** and choose **Create pairing code**.
4. The first time on the operator workstation, install the pinned runner and Chromium:

```powershell
npm.cmd run cloudflare:runner:install
```

5. Copy and run the one-time command shown by the panel. It has this shape:

```powershell
npm.cmd run cloudflare:runner -- --panel "http://127.0.0.1:8787" --code XXXX-XXXX
```

The runner opens a normal visible Chromium window and fills the official signup form. Submit it manually. The panel then polls only the selected AtomicMail inbox, accepts only a recent Cloudflare message and an HTTPS link on `cloudflare.com` or its real subdomains, and opens the link in an isolated browser context. An item becomes `verified` only after the runner confirms the email as verified in the Cloudflare profile.

The following conditions stop instead of guessing: a challenge, CAPTCHA, 429/policy response, an already-existing account, an unknown Cloudflare UI, an expired link, or an uncertain disconnect near Submit. Use **Focus browser** for a live manual step. **Retry safely** is available only when a new pre-submit attempt is known to be safe; **Reconcile login** signs in to inspect the existing account and never re-submits signup. If verification must be resent, click Cloudflare's visible resend control and then **I clicked Resend** in the panel so the 20-minute trusted-inbox window starts from that human action.

Cloudflare browser cookies are encrypted only while an item is recoverable and are deleted after verification or cancellation. Normal APIs never return the shared password, verification URL or browser state. Password reveal, failure-screenshot view and sensitive CSV export are POST-only, audited and returned with `Cache-Control: no-store`.

### Windows and Docker runner topology

- Direct Windows run: the runner and panel may both use `http://127.0.0.1:8787`.
- Local Docker Compose: the published port remains bound to host loopback. `CLOUDFLARE_RUNNER_DOCKER_LOOPBACK_HTTP=true` permits only the Docker bridge request whose Host is `127.0.0.1`/`localhost`.
- Remote Docker/server: enable `ADMIN_PASSWORD`, terminate HTTPS at a trusted reverse proxy, set `CLOUDFLARE_TRUST_PROXY=true`, and give the runner the public `https://` panel URL. The runner refuses plain HTTP for a non-loopback URL.

The panel supports queues of up to 100, but live rollout should begin with 1, then 3, then 5 accounts. A provider challenge or rate limit stops the workflow for review; the software cannot promise that Cloudflare will accept any particular volume.

</details>

## Restart and shutdown safety

On startup the database is reconciled before work resumes:

- an interrupted `running` item is returned to `pending`
- its interrupted attempt is not counted as a provider failure
- cancelled jobs remain cancelled
- job success/failure counters are recomputed from item state
- inconsistent terminal jobs with an in-flight item are reopened for recovery

On SIGINT/SIGTERM the panel stops accepting new work, aborts the active registration process, returns that item to `pending`, waits for the worker to become idle, checkpoints SQLite WAL, and exits. Docker uses a matching stop grace period.

If the process is force-killed before graceful shutdown finishes, startup recovery handles the remaining `running` item.


## Webmail — AM-21 → AM-30

Open **Mailboxes → Open inbox** to use an agent inbox without exposing its API key to the browser. The browser talks only to this panel; the server materializes the encrypted Atomic Mail credential into an isolated OS-temp runtime, invokes the official AgentSkill `jmap_request`, then immediately re-encrypts any refreshed credentials.

Available:

- Inbox and Sent with manual Refresh
- conservative auto-refresh (only while one mailbox is open and the tab is visible)
- provider-side sender/recipient/subject search, page size and position pagination
- open/read a message as sanitized plain text
- safe `http://` / `https://` links extracted from the message
- mark read/unread, Archive and move to Trash (no permanent-delete action)
- Compose / Send
- Reply, including attachments
- attachment metadata and guarded download
- heuristic verification-code/link detection with Copy/Open controls

Message HTML is never rendered directly in the operator page, and scripts are not executed. Message bodies are not written to the panel audit log. Provider API keys, JWTs and credential paths remain server-side.

Webmail remains **on-demand per mailbox**: it never loops over all stored mailboxes. Auto-refresh runs at a conservative interval only for the currently open mailbox, pauses while the browser tab is hidden, and stops when Webmail is closed.

Default mail guards:

```env
MAIL_COMMAND_TIMEOUT_MS=60000
MAIL_INBOX_LIMIT=50
MAIL_AUTO_REFRESH_SECONDS=45
MAIL_MAX_BODY_BYTES=524288
MAIL_MAX_COMPOSE_BYTES=204800
MAIL_MAX_SUBJECT_BYTES=2048
MAIL_MAX_SEARCH_BYTES=256
MAIL_MAX_ATTACHMENT_COUNT=5
MAIL_MAX_ATTACHMENT_BYTES=5242880
MAIL_MAX_TOTAL_ATTACHMENT_BYTES=10485760
```

## Exports

The Mailboxes page exports the current search as CSV or JSON. Provider credentials, credential paths and destination passwords are intentionally excluded. Exports are capped by `EXPORT_MAX_ROWS`.

**Export email + password** is a separate, explicit POST/CSRF-protected action with a warning confirmation. Its CSV contains plaintext destination passwords and must be handled as sensitive data. Reveal/copy actions are likewise explicit and audited without recording the password value.

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
5. Back up `data/` plus `secrets/data.key` separately; credentials under `data/` are encrypted, and losing the key makes them unrecoverable.
6. Keep `backups/` available for encrypted automatic restore points.

## Verification after deployment

```bash
curl --fail http://127.0.0.1:8787/health
docker compose ps
```

The service should report healthy before you use **Create emails**.

## Live validation status

AM-18 is complete after the first operator-approved real `@atomicmail.ai` inbox registration succeeded and appeared in the panel. AM-19 adds live phase/heartbeat/elapsed/ETA visibility so long sequential batches no longer look hung. AM-20 encrypts permanent provider credentials, adds verified automatic backups/offline restore, and makes mailbox credentials portable across machines when the encryption key is carried separately. AM-21→30 complete the multi-mailbox JMAP Webmail, actions, live refresh, search/pagination, attachments, verification helpers and mail security controls. AM-31→32 add the encrypted per-job destination-password vault and backup/restore integration. AM-33 adds full regression, security, migration, backup and restart coverage. AM-34 removes stale-response races all the way through safe JMAP read-process cancellation, replaces aggressive polling with an adaptive non-overlapping scheduler, and gives every long operator action immediate progress, elapsed-time and accessible busy feedback. AM-35 adds the isolated, operator-assisted Cloudflare signup/verification workflow and visible companion browser runner. Send/Reply and Cloudflare signup Submit remain deliberately non-cancellable after provider submission so their external state never becomes ambiguous.

The AM-33 production check also completed a read-only live JMAP smoke for both Inbox and Sent against a temporary copy of the existing vault. No message was sent, modified or deleted, and the source data directory was not migrated or rewritten by the smoke.

AM-36 retires the live Browser Runner from runtime and the primary UI. Cloudflare work is now a durable manual assistant with one independently encrypted random password per account, Focus Mode resume, strict duplicate protection, on-demand trusted Inbox verification, and explicit secret reveal/export actions.

## AM-20 — encrypted credential vault, backup and portability

Permanent Atomic Mail credentials are no longer stored as readable JSON. On the first start after this patch, legacy files such as:

```text
data/credentials/<username>/credentials.json
```

are authenticated, encrypted with AES-256-GCM and replaced by:

```text
data/credentials/<username>/credentials.json.enc
```

The original plaintext file is deleted only after an encrypt/decrypt verification succeeds. During a live AgentSkill operation, plaintext credentials exist only in an isolated OS temporary workspace; the workspace is sealed back into the encrypted vault immediately after the provider process exits. A hard-crash leftover is recovered/sealed on the next start when it contains complete matching credentials.

### Encryption key — do not lose this

By default the panel generates this file once:

```text
secrets/data.key
```

It is intentionally outside `data/` and excluded from Git/Docker build context. Back it up **separately**. The System page shows only a non-secret SHA-256 fingerprint, never the key itself.

For server migration, copy both:

```text
data/
secrets/data.key
```

The database credential paths are rebased automatically to the new machine, so Windows/Linux/path changes do not invalidate the mailboxes. If `secrets/data.key` is lost, encrypted API keys and `.ambak` backups cannot be decrypted.

An environment-provided 32-byte key is also supported through `DATA_ENCRYPTION_KEY` (base64 or 64 hex characters). When set, it takes precedence over the key file.

### File permissions

On Linux/macOS, storage directories are hardened to mode `0700` and secret files to `0600`. On Windows, the panel attempts to replace inherited NTFS ACLs on `data/`, `secrets/`, and `backups/` with access for the current user and SYSTEM. The System page surfaces a warning if OS-level hardening cannot be applied. Encryption remains the primary protection for provider API keys.

### Encrypted automatic backups

Backups are written to `backups/` as authenticated `.ambak` files. Each backup contains a consistent SQLite snapshot plus the encrypted credential vault, then the whole compressed payload is encrypted again with a purpose-derived AES-256-GCM key.

Per-job destination passwords live only as AES-256-GCM ciphertext in SQLite under a separate HKDF purpose and job-bound authenticated data. They are included automatically in the SQLite snapshot and survive restore only when the matching `secrets/data.key` is available.

Defaults:

```env
AUTO_BACKUP_ENABLED=true
AUTO_BACKUP_INTERVAL_MINUTES=360
BACKUP_MIN_GAP_MINUTES=5
BACKUP_RETENTION=14
```

A successful mailbox creation or a new destination-password job requests a debounced backup; scheduled backups run as a second layer, and graceful shutdown creates a final backup whenever persisted job/mailbox data exists. A backup is only reported successful after decryption and SQLite `integrity_check` pass.

The **System → Data safety & portability** card can create a backup manually and verify the latest backup without exposing any credential material.

CLI:

```powershell
npm.cmd run backup:status
npm.cmd run backup:create
npm.cmd run backup:verify
```

### Offline restore

Restore is intentionally not exposed as a one-click web action because replacing a live SQLite database is unsafe. Stop the panel first, then run:

```powershell
npm.cmd run backup:restore -- atomicmail-backup-....ambak
```

Before replacement, the restore command attempts to create a fresh encrypted `pre-restore` safety backup. It authenticates/decrypts the selected backup, validates SQLite integrity, restores the encrypted credential files, and rebases credential paths to the current machine.

A PID lock prevents restore while the panel is still running.
