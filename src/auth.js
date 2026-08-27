import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'atomicmail_admin';

function hash(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function constantTimeEqual(left, right) {
  return timingSafeEqual(hash(left), hash(right));
}

function parseCookies(header = '') {
  const result = new Map();
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result.set(key, decodeURIComponent(value));
    } catch {
      result.set(key, value);
    }
  }
  return result;
}

function cookieValue(sessionId, maxAgeSeconds, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieValue(secure) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export class AdminAuth {
  constructor(config) {
    this.enabled = Boolean(config.adminPassword);
    this.username = config.adminUsername;
    this.password = config.adminPassword;
    this.sessionTtlMs = config.adminSessionTtlMs;
    this.loginMaxAttempts = config.adminLoginMaxAttempts;
    this.loginWindowMs = config.adminLoginWindowMs;
    this.cookieSecure = config.adminCookieSecure;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [ip, attempt] of this.attempts) {
      if (attempt.windowStartedAt + this.loginWindowMs <= now) this.attempts.delete(ip);
    }
  }

  getSession(req, { refresh = true } = {}) {
    if (!this.enabled) return { id: null, csrf: null, expiresAt: null, username: this.username };
    this.prune();
    const sessionId = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.sessions.delete(sessionId);
      return null;
    }
    if (refresh) session.expiresAt = Date.now() + this.sessionTtlMs;
    return session;
  }

  status(req) {
    const session = this.getSession(req);
    if (!this.enabled) {
      return {
        authRequired: false,
        authenticated: true,
        username: this.username,
        csrf: null,
        expiresAt: null,
      };
    }
    return {
      authRequired: true,
      authenticated: Boolean(session),
      username: session?.username ?? null,
      csrf: session?.csrf ?? null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    };
  }

  canAttempt(ip) {
    this.prune();
    const current = this.attempts.get(ip);
    if (!current) return { allowed: true, retryAfterMs: 0 };
    if (current.count < this.loginMaxAttempts) return { allowed: true, retryAfterMs: 0 };
    const retryAfterMs = Math.max(0, current.windowStartedAt + this.loginWindowMs - Date.now());
    return retryAfterMs > 0
      ? { allowed: false, retryAfterMs }
      : { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(ip) {
    const now = Date.now();
    const current = this.attempts.get(ip);
    if (!current || current.windowStartedAt + this.loginWindowMs <= now) {
      this.attempts.set(ip, { count: 1, windowStartedAt: now });
      return;
    }
    current.count += 1;
  }

  login({ username, password, ip }) {
    if (!this.enabled) {
      return { ok: true, session: this.getSession({ headers: {} }), setCookie: null };
    }

    const allowance = this.canAttempt(ip);
    if (!allowance.allowed) {
      return { ok: false, rateLimited: true, retryAfterMs: allowance.retryAfterMs };
    }

    const valid = constantTimeEqual(username, this.username) && constantTimeEqual(password, this.password);
    if (!valid) {
      this.recordFailure(ip);
      return { ok: false, rateLimited: false, retryAfterMs: 0 };
    }

    this.attempts.delete(ip);
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const session = {
      id,
      csrf,
      username: this.username,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    this.sessions.set(id, session);
    return {
      ok: true,
      session,
      setCookie: cookieValue(id, Math.floor(this.sessionTtlMs / 1000), this.cookieSecure),
    };
  }

  verifyCsrf(req, session) {
    if (!this.enabled) return true;
    const supplied = req.headers['x-atomicmail-csrf'];
    return typeof supplied === 'string' && constantTimeEqual(supplied, session?.csrf || '');
  }

  logout(req) {
    if (this.enabled) {
      const sessionId = parseCookies(req.headers.cookie).get(COOKIE_NAME);
      if (sessionId) this.sessions.delete(sessionId);
    }
    return clearCookieValue(this.cookieSecure);
  }
}
