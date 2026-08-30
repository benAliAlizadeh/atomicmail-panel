function abortError() {
  return Object.assign(new Error('Mail request was cancelled'), {
    name: 'MailClientError', statusCode: 499, code: 'mail_cancelled', expose: true,
  });
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return 0;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const explicit = text.match(/retry[- ]?after[^0-9]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)?/i);
  if (explicit) {
    const amount = Number(explicit[1]);
    return Math.max(0, Math.ceil(amount * (/^m/i.test(explicit[2] || '') ? 1 : 1000)));
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function rateLimitDetails(error, now = Date.now()) {
  const message = String(error?.message || error || '');
  const statusCode = Number(error?.statusCode || error?.status || message.match(/HTTP\s+(429)\b/i)?.[1] || 0);
  const isRateLimit = statusCode === 429 || /rate[_ -]?limit|too many requests/i.test(message);
  if (!isRateLimit) return null;
  const retryAfterMs = Math.max(
    Number(error?.retryAfterMs || 0),
    parseRetryAfter(error?.retryAfter, now),
    parseRetryAfter(message, now),
  );
  return { retryAfterMs, statusCode: 429 };
}

function isTransient(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  if ([408, 425].includes(status) || status >= 500) return true;
  return /timeout|timed out|network|fetch failed|connection (?:reset|closed)|econnreset|eai_again/i
    .test(String(error?.message || ''));
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    // Keep retry/backoff timers referenced while a scheduled request is awaiting
    // them. Unref'ing this timer lets short-lived callers (including tests and
    // maintenance scripts) exit with an unresolved mail operation.
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export class JmapRequestCoordinator {
  constructor({
    executor,
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    minIntervalMs = 500,
    random = Math.random,
    now = Date.now,
  } = {}) {
    if (typeof executor !== 'function') throw new Error('JmapRequestCoordinator requires an executor');
    this.executor = executor;
    this.maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.baseDelayMs = Math.max(10, Number(baseDelayMs) || 1000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 30000);
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.random = random;
    this.now = now;
    this.interactive = [];
    this.background = [];
    this.coalesced = new Map();
    this.running = false;
    this.activeMailbox = null;
    this.blockedUntil = 0;
    this.nextRequestAt = 0;
    this.interactiveStreak = 0;
  }

  status() {
    return {
      activeMailbox: this.activeMailbox,
      queuedInteractive: this.interactive.length,
      queuedBackground: this.background.length,
      retryAt: this.blockedUntil > this.now() ? new Date(this.blockedUntil).toISOString() : null,
    };
  }

  schedule(username, operation, { priority = 'interactive', signal = null, coalesceKey = '' } = {}) {
    const mailbox = String(username || '');
    const background = priority === 'background';
    const key = background && coalesceKey ? `${mailbox}:${coalesceKey}` : '';
    if (key && this.coalesced.has(key)) return this.coalesced.get(key);
    const promise = new Promise((resolve, reject) => {
      const task = { mailbox, operation, signal, resolve, reject, key };
      (background ? this.background : this.interactive).push(task);
      void this.drain();
    });
    if (key) {
      this.coalesced.set(key, promise);
      promise.finally(() => this.coalesced.delete(key)).catch(() => {});
    }
    return promise;
  }

  nextTask() {
    // Interactive webmail stays responsive, while every fourth opportunity is
    // reserved for background verification so it cannot starve indefinitely.
    if (this.interactive.length && (!this.background.length || this.interactiveStreak < 3)) {
      this.interactiveStreak += 1;
      return this.interactive.shift();
    }
    if (this.background.length) {
      this.interactiveStreak = 0;
      return this.background.shift();
    }
    this.interactiveStreak = 0;
    return null;
  }

  async runTask(task) {
    if (task.signal?.aborted) throw abortError();
    for (let attempt = 0; ; attempt += 1) {
      const waitMs = Math.max(0, this.blockedUntil - this.now(), this.nextRequestAt - this.now());
      if (waitMs) await sleep(waitMs, task.signal);
      try {
        const result = await this.executor(task.mailbox, task.operation, { signal: task.signal, attempt });
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + this.minIntervalMs);
        return result;
      } catch (error) {
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + this.minIntervalMs);
        const rate = rateLimitDetails(error, this.now());
        if (!rate && !isTransient(error)) throw error;
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        const jittered = Math.ceil(exponential * (0.75 + this.random() * 0.5));
        const retryAfterMs = Math.max(rate?.retryAfterMs || 0, jittered);
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryAfterMs);
        if (attempt >= this.maxRetries) {
          if (!rate) throw error;
          error.name = 'MailClientError';
          error.statusCode = 429;
          error.code = 'mail_rate_limited';
          error.retryAfterMs = retryAfterMs;
          error.retryAt = new Date(this.blockedUntil).toISOString();
          error.expose = true;
          error.message = 'Atomic Mail is temporarily rate limiting requests. Retrying automatically…';
          throw error;
        }
      }
    }
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.nextTask(); task; task = this.nextTask()) {
        this.activeMailbox = task.mailbox;
        try {
          task.resolve(await this.runTask(task));
        } catch (error) {
          task.reject(error);
        } finally {
          this.activeMailbox = null;
        }
      }
    } finally {
      this.running = false;
      if (this.interactive.length || this.background.length) void this.drain();
    }
  }
}
