import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redactSecrets, safeJsonParse } from './utils.js';

export class ProviderError extends Error {
  constructor(message, { kind = 'permanent', retryAfterMs = null, raw = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.raw = raw;
  }
}

export function classifyProviderError(rawInput) {
  const raw = redactSecrets(rawInput || '');
  const text = raw.toLowerCase();
  const retryMatch = text.match(/retry[- ]?after[^0-9]*(\d+)/i);
  const retryAfterMs = retryMatch ? Number(retryMatch[1]) * 1000 : null;

  if (/\b429\b|rate.?limit|too many requests/.test(text)) {
    return { kind: 'rate_limited', retryAfterMs, message: 'Atomic Mail rate limit reached' };
  }
  if (/abuse|policy|prohibited|suspend|\b403\b|forbidden|registration blocked/.test(text)) {
    return { kind: 'policy', retryAfterMs: null, message: 'Atomic Mail policy/abuse protection stopped registration' };
  }
  if (/username/.test(text) && /(taken|exists|unavailable|already|conflict)/.test(text)) {
    return { kind: 'username_conflict', retryAfterMs: null, message: 'Username is unavailable' };
  }
  if (/\b5\d\d\b|timeout|timed out|econnreset|enotfound|network|temporar|service unavailable|socket hang up/.test(text)) {
    return { kind: 'transient', retryAfterMs: null, message: 'Temporary Atomic Mail/network failure' };
  }
  return { kind: 'permanent', retryAfterMs: null, message: 'Atomic Mail registration failed' };
}

function runProcess(command, args, { env, timeoutMs, outputLimit = 131072 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
  let timedOut = false;

    const append = (current, chunk) => {
      if (current.length >= outputLimit) return current;
      return (current + chunk.toString('utf8')).slice(0, outputLimit);
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export class AtomicMailProvider {
  constructor(config) {
    this.config = config;
  }

  credentialsDir(username) {
    return path.join(this.config.credentialsRoot, username);
  }

  async register(username) {
    const credentialsDir = this.credentialsDir(username);
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });

    // Crash-safe idempotency: the official CLI owns this credential directory.
    // If registration completed before our DB commit and the process restarted,
    // reuse the already-created inbox instead of attempting another signup.
    const existingCredentialsPath = path.join(credentialsDir, 'credentials.json');
    if (fs.existsSync(existingCredentialsPath)) {
      const existing = safeJsonParse(fs.readFileSync(existingCredentialsPath, 'utf8'), {});
      const inboxId = typeof existing?.inboxId === 'string' ? existing.inboxId : '';
      const expectedLocalPart = inboxId.includes('@') ? inboxId.split('@', 1)[0].toLowerCase() : '';
      if (inboxId && expectedLocalPart === username.toLowerCase()) {
        try { fs.chmodSync(credentialsDir, 0o700); } catch {}
        try { fs.chmodSync(existingCredentialsPath, 0o600); } catch {}
        return { username, email: inboxId, inboxId, credentialsPath: existingCredentialsPath };
      }
      throw new ProviderError('Credential directory already exists but does not match the requested username', {
        kind: 'policy',
        raw: 'Credential directory mismatch; refusing to overwrite provider credentials',
      });
    }

    const env = {
      ...process.env,
      ATOMIC_MAIL_CREDENTIALS_DIR: credentialsDir,
      ATOMIC_MAIL_AUTH_URL: this.config.atomicAuthUrl,
      ATOMIC_MAIL_API_URL: this.config.atomicApiUrl,
      NO_COLOR: '1',
    };
    const args = [...this.config.atomicCliPrefixArgs, 'register', '--username', username];

    let result;
    try {
      result = await runProcess(this.config.atomicCliCommand, args, {
        env,
        timeoutMs: this.config.registerTimeoutMs,
      });
    } catch (error) {
      const classified = classifyProviderError(error?.message || String(error));
      throw new ProviderError(classified.message, {
        ...classified,
        raw: redactSecrets(error?.message || String(error)),
      });
    }

    const combined = redactSecrets(`${result.stdout}\n${result.stderr}`.trim());
    if (result.timedOut) {
      throw new ProviderError('Atomic Mail registration process timed out', {
        kind: 'transient',
        raw: combined || 'registration timeout',
      });
    }
    if (result.code !== 0) {
      const classified = classifyProviderError(combined || `CLI exited with code ${result.code}, signal ${result.signal || 'none'}`);
      throw new ProviderError(classified.message, { ...classified, raw: combined });
    }

    const credentialsPath = path.join(credentialsDir, 'credentials.json');
    if (!fs.existsSync(credentialsPath)) {
      throw new ProviderError('Atomic Mail CLI exited successfully but credentials.json was not created', {
        kind: 'transient',
        raw: combined,
      });
    }

    try { fs.chmodSync(credentialsDir, 0o700); } catch {}
    try { fs.chmodSync(credentialsPath, 0o600); } catch {}

    const credentials = safeJsonParse(fs.readFileSync(credentialsPath, 'utf8'), {});
    const inboxId = typeof credentials?.inboxId === 'string' && credentials.inboxId.includes('@')
      ? credentials.inboxId
      : `${username}@atomicmail.ai`;

    return {
      username,
      email: inboxId,
      inboxId,
      credentialsPath,
    };
  }
}
