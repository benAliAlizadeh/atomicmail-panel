import { retryDelay, redactSecrets } from './utils.js';

const CIRCUIT_KEY = 'cloudflare.circuit';
const NOT_BEFORE_KEY = 'cloudflare.not_before';

function cleanCode(value, fallback = 'cloudflare_error') {
  const code = String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80);
  return code || fallback;
}

function cleanMessage(value, fallback = 'Cloudflare operation failed') {
  return redactSecrets(String(value || fallback))
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 700);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudflareOrchestrator {
  constructor({ cloudflareStore, store, vault, mailClient, runnerManager, artifactStore, config, backupManager = null }) {
    this.cloudflareStore = cloudflareStore;
    this.store = store;
    this.vault = vault;
    this.mailClient = mailClient;
    this.runnerManager = runnerManager;
    this.artifactStore = artifactStore;
    this.config = config;
    this.backupManager = backupManager;
    this.timer = null;
    this.busy = false;
    this.stopping = false;
  }

  start() {
    if (this.timer || !this.config.cloudflareEnabled) return;
    this.stopping = false;
    this.cloudflareStore.recoverInterruptedWork();
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.store.audit('error', 'cloudflare.tick_failed', cleanMessage(error?.stack || error));
    }), Number(this.config.cloudflareWorkerPollMs || 1000));
    this.timer.unref?.();
    void this.tick();
  }

  async stop({ waitMs = this.config.shutdownGraceMs || 15000 } = {}) {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runnerManager.requestCommand('cancel', this.cloudflareStore.activeItem()?.id || '');
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (this.busy && Date.now() < deadline) await sleep(25);
    return !this.busy;
  }

  circuitState() {
    const raw = this.store.getState(CIRCUIT_KEY, '');
    if (!raw) return { open: false, until: null, reason: null };
    try {
      const state = JSON.parse(raw);
      if (state.until && Date.parse(state.until) <= Date.now()) {
        this.store.clearState(CIRCUIT_KEY);
        return { open: false, until: null, reason: null };
      }
      return { open: true, until: state.until || null, reason: state.reason || 'Cloudflare circuit is open' };
    } catch {
      this.store.clearState(CIRCUIT_KEY);
      return { open: false, until: null, reason: null };
    }
  }

  openCircuit(ms, reason) {
    const until = new Date(Date.now() + Math.max(60000, Number(ms) || 900000)).toISOString();
    this.store.setState(CIRCUIT_KEY, JSON.stringify({ until, reason: cleanMessage(reason) }));
    this.store.audit('warn', 'cloudflare.circuit_opened', `Cloudflare circuit open until ${until}: ${cleanMessage(reason)}`);
  }

  resetCircuit() {
    this.store.clearState(CIRCUIT_KEY);
    this.store.audit('info', 'cloudflare.circuit_reset', 'Cloudflare circuit reset by operator');
  }

  notBefore() {
    return Date.parse(this.store.getState(NOT_BEFORE_KEY, '') || '') || 0;
  }

  setNotBefore(ms) {
    this.store.setState(NOT_BEFORE_KEY, new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString());
  }

  status() {
    return {
      enabled: Boolean(this.config.cloudflareEnabled),
      busy: this.busy,
      concurrency: 1,
      circuit: this.circuitState(),
      runner: this.runnerManager.status(),
      limits: {
        maxBatchSize: Number(this.config.cloudflareMaxBatchSize || 100),
        emailPollMs: Number(this.config.cloudflareEmailPollMs || 15000),
        verificationTimeoutMs: Number(this.config.cloudflareVerificationTimeoutMs || 300000),
      },
    };
  }

  async tick() {
    if (this.busy || this.stopping || !this.config.cloudflareEnabled) return;
    this.busy = true;
    try {
      this.artifactStore?.pruneIfDue?.();
      this.cloudflareStore.releaseExpiredLease();
      if (this.circuitState().open || this.notBefore() > Date.now()) return;

      const active = this.cloudflareStore.activeItem();
      if (active?.status === 'waiting_for_verification') {
        if (Date.parse(active.next_attempt_at || '') <= Date.now()) await this.pollVerification(active);
        return;
      }
      if (active) return;
      if (!this.runnerManager.liveSession()) return;
      this.cloudflareStore.beginNextSignup();
    } finally {
      this.busy = false;
    }
  }

  async pollVerification(item) {
    const submittedAt = Date.parse(item.submitted_at || '');
    if (!Number.isFinite(submittedAt)) {
      this.cloudflareStore.markNeedsAction(item.id, 'submission_time_missing', 'Signup submission time is missing; reconcile this account manually');
      return;
    }
    const waitStartedAt = Date.parse(item.verification_wait_started_at || item.submitted_at || '');
    if (Number.isFinite(waitStartedAt)
      && Date.now() - waitStartedAt >= Number(this.config.cloudflareVerificationTimeoutMs || 300000)) {
      this.cloudflareStore.markNeedsAction(item.id, 'verification_email_timeout', 'No trusted Cloudflare verification email arrived within the configured timeout');
      this.store.audit('warn', 'cloudflare.verification_timeout', `Verification email timed out for ${item.email}`, item.job_id, item.id);
      return;
    }
    try {
      const found = await this.mailClient.findCloudflareVerification(item.username, {
        recipient: item.email,
        submittedAt: item.submitted_at,
      });
      if (!found) {
        this.cloudflareStore.scheduleVerificationPoll(item.id, this.config.cloudflareEmailPollMs);
        return;
      }
      const ciphertext = this.vault.sealCloudflareSecret(found.url, {
        purpose: 'cloudflare-verification-url', id: item.id,
      });
      this.cloudflareStore.markVerificationFound(item.id, ciphertext, found.receivedAt);
      this.store.audit('info', 'cloudflare.verification_email_found', `Trusted Cloudflare verification email found for ${item.email}`, item.job_id, item.id);
      this.backupManager?.requestBackup('cloudflare-verification-found');
    } catch (error) {
      const isRateLimit = error?.code === 'mail_rate_limited' || Number(error?.statusCode) === 429;
      const delay = Math.max(
        Number(this.config.cloudflareEmailPollMs || 15000),
        Number(error?.retryAfterMs || 0),
      );
      if (isRateLimit) {
        this.cloudflareStore.scheduleVerificationPoll(
          item.id,
          delay,
          'Atomic Mail is temporarily rate limiting requests. Retrying automatically…',
        );
        return;
      }
      const message = cleanMessage(error?.message, 'AtomicMail verification polling failed');
      this.cloudflareStore.scheduleVerificationPoll(item.id, delay, 'Inbox check could not complete. Retrying automatically…');
      this.store.audit('warn', 'cloudflare.verification_poll_failed', `Inbox polling failed for ${item.email}: ${message}`, item.job_id, item.id);
    }
  }

  claimTask(session) {
    if (this.circuitState().open) return null;
    const liveSession = this.runnerManager.liveSession();
    if (!liveSession || liveSession !== session || session?.revoked) return null;
    const item = this.cloudflareStore.claimRunnerTask(session.id, this.config.cloudflareRunnerLeaseMs);
    if (!item) return null;
    const password = this.vault.openCloudflareSecret(item.password_ciphertext, {
      purpose: 'cloudflare-job-password', id: item.job_id,
    });
    let storageState = null;
    if (item.browser_state_ciphertext) {
      try {
        storageState = JSON.parse(this.vault.openCloudflareSecret(item.browser_state_ciphertext, {
          purpose: 'cloudflare-browser-state', id: item.id,
        }));
      } catch (error) {
        this.cloudflareStore.markNeedsAction(item.id, 'browser_state_corrupt', 'Encrypted browser recovery state could not be restored');
        return null;
      }
    }
    const base = {
      id: item.id,
      generation: item.lease_generation,
      email: item.email,
      password,
      storageState,
      manualSignupSubmit: true,
    };
    if (item.status === 'creating' && item.phase === 'reconciling') {
      return { ...base, kind: 'reconcile', url: this.config.cloudflareLoginUrl || 'https://dash.cloudflare.com/login' };
    }
    if (item.status === 'creating') return { ...base, kind: 'signup', url: this.config.cloudflareSignupUrl };
    if (item.status === 'verifying') {
      const verificationUrl = this.vault.openCloudflareSecret(item.verification_url_ciphertext, {
        purpose: 'cloudflare-verification-url', id: item.id,
      });
      return { ...base, kind: 'verify', url: verificationUrl };
    }
    return null;
  }

  heartbeat(session, body) {
    const activeItemId = body?.activeItemId ? String(body.activeItemId) : null;
    const generation = body?.generation == null ? null : Number(body.generation);
    if (activeItemId && generation != null) {
      this.cloudflareStore.renewLease(activeItemId, session.id, generation, this.config.cloudflareRunnerLeaseMs);
    }
    return this.runnerManager.heartbeat(session, { activeItemId, generation });
  }

  sealStorageState(itemId, value) {
    if (value == null) return null;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) throw new Error('Browser storage state is too large');
    return this.vault.sealCloudflareSecret(serialized, { purpose: 'cloudflare-browser-state', id: itemId });
  }

  saveArtifact(item, screenshotBase64) {
    if (!screenshotBase64) return;
    try {
      const name = this.artifactStore.save(item.id, item.attempts, screenshotBase64);
      this.cloudflareStore.setArtifact(item.id, name);
    } catch (error) {
      this.store.audit('warn', 'cloudflare.artifact_failed', cleanMessage(error?.message), item.job_id, item.id);
    }
  }

  handleRunnerEvent(session, itemId, generation, body) {
    const item = this.cloudflareStore.getItem(itemId);
    if (!item) throw Object.assign(new Error('Cloudflare item not found'), { statusCode: 404, expose: true });
    if (!this.cloudflareStore.validateLease(item.id, session.id, generation)) {
      throw Object.assign(new Error('Cloudflare task lease is stale or expired'), { statusCode: 409, code: 'stale_runner_lease', expose: true });
    }
    const event = String(body?.event || '').toLowerCase();
    this.saveArtifact(item, body?.screenshotBase64);
    if (event === 'progress') {
      this.cloudflareStore.updateProgress(item.id, session.id, generation, body.phase, body.message);
    } else if (event === 'awaiting_submit') {
      this.cloudflareStore.markAwaitingSubmit(item.id, session.id, generation, this.sealStorageState(item.id, body.storageState));
    } else if (event === 'signup_accepted' || event === 'verification_requested') {
      const acceptedEvidence = new Set([
        'verification_prompt_with_email',
        'verification_prompt_after_operator_submit',
        'resend_prompt_with_email',
        'resend_prompt_after_operator_action',
      ]);
      const evidence = cleanCode(body.evidence, '');
      const expectedState = event === 'signup_accepted'
        ? item.status === 'awaiting_submit'
          || (item.status === 'needs_action' && item.last_error_code === 'challenge')
        : item.phase === 'needs_action' && item.last_error_code === 'verification_pending';
      if (!expectedState || !acceptedEvidence.has(evidence)) {
        throw Object.assign(new Error('Cloudflare signup acceptance evidence is invalid for the current state'), {
          statusCode: 409, code: 'invalid_signup_acceptance', expose: true,
        });
      }
      this.cloudflareStore.markSubmitted(
        item.id, session.id, generation, this.sealStorageState(item.id, body.storageState),
        { resetSubmittedAt: event === 'verification_requested', evidence },
      );
      this.cloudflareStore.setJobStatus(item.job_id, 'running');
      this.store.audit(
        'info',
        event === 'signup_accepted' ? 'cloudflare.signup_accepted' : 'cloudflare.verification_request_accepted',
        `Cloudflare browser confirmed ${event === 'signup_accepted' ? 'signup' : 'verification request'} for ${item.email}`,
        item.job_id,
        item.id,
      );
      this.backupManager?.requestBackup('cloudflare-signup-submitted');
    } else if (event === 'needs_action') {
      const code = cleanCode(body.code, 'runner_needs_action');
      const message = cleanMessage(body.message, 'Continue in the visible Chromium window');
      this.cloudflareStore.markNeedsAction(item.id, code, message, { preserveLease: Boolean(body.keepTaskOpen) });
      this.store.audit('warn', 'cloudflare.needs_action', `${item.email}: ${code} - ${message}`, item.job_id, item.id);
    } else if (event === 'verified') {
      this.cloudflareStore.markVerified(item.id, session.id, generation, body.cloudflareAccountId);
      this.store.audit('info', 'cloudflare.verified', `Verified Cloudflare email for ${item.email}`, item.job_id, item.id);
      this.backupManager?.requestBackup('cloudflare-account-verified');
      this.setNotBefore(this.config.cloudflarePostItemDelayMs);
    } else if (event === 'failed') {
      this.handleRunnerFailure(item, body);
    } else {
      throw Object.assign(new Error('Cloudflare runner event is invalid'), { statusCode: 400, expose: true });
    }
    return this.cloudflareStore.getItem(item.id);
  }

  handleRunnerFailure(item, body) {
    const code = cleanCode(body?.code);
    const message = cleanMessage(body?.message);
    if (code === 'rate_limited' || code === 'policy_blocked') {
      this.cloudflareStore.markNeedsAction(item.id, code, message);
      this.openCircuit(this.config.cloudflareRateLimitCooldownMs, message);
      return;
    }
    if (body?.uncertain || item.submitted_at || ['account_exists', 'challenge', 'unknown_ui'].includes(code)) {
      const needsActionCode = body?.uncertain && !item.submitted_at ? 'submission_state_unknown' : code;
      this.cloudflareStore.markNeedsAction(item.id, needsActionCode, message);
      return;
    }
    if (body?.retryable && Number(item.attempts || 0) <= Number(this.config.cloudflareMaxRetries || 3)) {
      const delay = retryDelay(item.attempts, this.config.cloudflareRetryBaseMs, this.config.cloudflareRetryMaxMs);
      this.cloudflareStore.rescheduleItem(item.id, delay, code, message);
      return;
    }
    this.cloudflareStore.markFailed(item.id, code, message);
  }
}
