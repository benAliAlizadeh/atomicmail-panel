import { generateUsername } from './username-generator.js';
import { retryDelay, redactSecrets } from './utils.js';

const CIRCUIT_KEY = 'worker.circuit';
const NOT_BEFORE_KEY = 'worker.not_before';

export class JobWorker {
  constructor({ store, provider, config }) {
    this.store = store;
    this.provider = provider;
    this.config = config;
    this.timer = null;
    this.busy = false;
    this.consecutiveTransientFailures = 0;
  }

  start() {
    if (this.timer || !this.config.workerEnabled) return;
    this.store.recoverInterruptedWork();
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.store.audit('error', 'worker.tick_error', redactSecrets(error?.stack || String(error)));
    }), this.config.workerPollMs);
    this.timer.unref();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  circuitState() {
    const raw = this.store.getState(CIRCUIT_KEY, '');
    if (!raw) return { open: false, permanent: false, until: null, reason: null };
    try {
      const state = JSON.parse(raw);
      if (!state.permanent && state.until && Date.parse(state.until) <= Date.now()) {
        this.store.clearState(CIRCUIT_KEY);
        return { open: false, permanent: false, until: null, reason: null };
      }
      return { open: true, ...state };
    } catch {
      this.store.clearState(CIRCUIT_KEY);
      return { open: false, permanent: false, until: null, reason: null };
    }
  }

  openTemporaryCircuit(ms, reason) {
    const until = new Date(Date.now() + ms).toISOString();
    this.store.setState(CIRCUIT_KEY, JSON.stringify({ permanent: false, until, reason }));
    this.store.audit('warn', 'worker.circuit_opened', `${reason}; retry after ${until}`);
  }

  openPermanentCircuit(reason) {
    this.store.setState(CIRCUIT_KEY, JSON.stringify({ permanent: true, until: null, reason }));
    this.store.audit('error', 'worker.circuit_opened_permanent', reason);
  }

  resetCircuit() {
    this.store.clearState(CIRCUIT_KEY);
    this.consecutiveTransientFailures = 0;
    this.store.audit('info', 'worker.circuit_reset', 'Circuit breaker reset by operator');
  }

  notBefore() {
    const raw = this.store.getState(NOT_BEFORE_KEY, '');
    return raw ? Date.parse(raw) : 0;
  }

  setNotBefore(msFromNow) {
    this.store.setState(NOT_BEFORE_KEY, new Date(Date.now() + msFromNow).toISOString());
  }

  newUniqueUsername(prefix) {
    for (let i = 0; i < 100; i += 1) {
      const username = generateUsername({
        prefix,
        minLength: this.config.usernameMinLength,
        maxLength: this.config.usernameMaxLength,
      });
      if (!this.store.isUsernameTaken(username)) return username;
    }
    throw new Error('Unable to generate an unused username');
  }

  async tick() {
    if (this.busy) return;
    const circuit = this.circuitState();
    if (circuit.open) return;
    if (this.notBefore() > Date.now()) return;

    const candidate = this.store.nextRunnableItem();
    if (!candidate) return;

    this.busy = true;
    const item = this.store.markItemRunning(candidate.id);
    if (!item) {
      this.busy = false;
      return;
    }

    try {
      const mailbox = await this.provider.register(item.username);
      this.store.markItemSucceeded(item.id, mailbox);
      this.store.audit('info', 'mailbox.created', `Created ${mailbox.email}`, item.job_id, item.id);
      this.consecutiveTransientFailures = 0;
      this.setNotBefore(this.config.postSuccessDelayMs);
    } catch (error) {
      await this.handleFailure(item, error);
    } finally {
      this.busy = false;
    }
  }

  async handleFailure(item, error) {
    const kind = error?.kind || 'permanent';
    const raw = redactSecrets(error?.raw || error?.message || String(error));
    const safeMessage = raw || 'Provider registration failed';

    if (kind === 'username_conflict') {
      const replacement = this.newUniqueUsername(this.store.getJob(item.job_id)?.prefix || '');
      this.store.replaceItemUsername(item.id, replacement, 1000, 'Previous username unavailable; regenerated automatically');
      this.store.audit('warn', 'mailbox.username_regenerated', `${item.username} unavailable; generated ${replacement}`, item.job_id, item.id);
      return;
    }

    if (kind === 'rate_limited') {
      const delay = error.retryAfterMs || this.config.rateLimitCooldownMs;
      this.store.rescheduleItem(item.id, delay, 'Rate limited; waiting before retry');
      this.openTemporaryCircuit(delay, 'Atomic Mail rate limit');
      return;
    }

    if (kind === 'policy') {
      this.store.rescheduleItem(item.id, this.config.rateLimitCooldownMs, 'Stopped by Atomic Mail policy/abuse protection');
      this.store.setJobStatus(item.job_id, 'paused');
      this.openPermanentCircuit('Atomic Mail policy/abuse protection response. Manual review is required before continuing.');
      return;
    }

    if (kind === 'transient') {
      this.consecutiveTransientFailures += 1;
      if (item.attempts <= this.config.maxRetries) {
        const delay = retryDelay(item.attempts, this.config.retryBaseMs, this.config.retryMaxMs);
        this.store.rescheduleItem(item.id, delay, safeMessage);
        this.store.audit('warn', 'mailbox.retry_scheduled', `Retry ${item.attempts}/${this.config.maxRetries} in ${delay}ms`, item.job_id, item.id);
      } else {
        this.store.markItemFailed(item.id, safeMessage);
        this.store.audit('error', 'mailbox.failed', `Retry limit exhausted: ${safeMessage}`, item.job_id, item.id);
      }

      if (this.consecutiveTransientFailures >= this.config.transientCircuitThreshold) {
        this.openTemporaryCircuit(this.config.transientCircuitCooldownMs, 'Repeated transient provider/network failures');
        this.consecutiveTransientFailures = 0;
      }
      return;
    }

    this.store.markItemFailed(item.id, safeMessage);
    this.store.audit('error', 'mailbox.failed', safeMessage, item.job_id, item.id);
  }
}
