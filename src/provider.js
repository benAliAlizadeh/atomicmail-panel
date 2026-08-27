import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redactSecrets } from './utils.js';

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

export function resolveProviderInvocation(command, args, {
  platform = process.platform,
  execPath = process.execPath,
  existsSync = fs.existsSync,
} = {}) {
  const normalized = String(command || '').trim().toLowerCase();

  // On Windows, npm/npx are .cmd shims. child_process.spawn(..., shell:false)
  // cannot reliably execute those shims directly. Use the Node executable and
  // npm's real npx JavaScript entrypoint instead; this avoids shell quoting and
  // does not depend on PATHEXT/PATH behavior.
  if (platform === 'win32' && (normalized === 'npx' || normalized === 'npx.cmd')) {
    const pathApi = path.win32;
    const npxCliPath = pathApi.join(pathApi.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (!existsSync(npxCliPath)) {
      throw new ProviderError(
        `Windows npx launcher was not found at ${npxCliPath}. Reinstall Node.js with npm or configure ATOMICMAIL_CLI_COMMAND explicitly.`,
        { kind: 'permanent', raw: 'Local npx launcher is unavailable; provider was not contacted' },
      );
    }
    return { command: execPath, args: [npxCliPath, ...args] };
  }

  return { command, args };
}

function emitProgress(callback, phase, message) {
  if (typeof callback !== 'function') return;
  try { callback({ phase, message, at: new Date().toISOString() }); } catch {}
}

function progressFromOutput(chunk) {
  const text = redactSecrets(String(chunk || '')).toLowerCase();
  if (!text) return null;
  if (/capabilit/.test(text)) return ['capability', 'Capability token created; finalizing inbox access'];
  if (/session/.test(text)) return ['session', 'Authenticated session established'];
  if (/scrypt|proof[- ]?of[- ]?work|\bpow\b/.test(text)) return ['proof_of_work', 'Solving Atomic Mail proof-of-work'];
  if (/challenge/.test(text)) return ['challenge', 'Registration challenge received'];
  if (/credential|accountid|\binbox\b/.test(text)) return ['finalizing', 'Provider returned inbox details; validating credentials'];
  return null;
}

function runProcess(command, args, { env, timeoutMs, signal, outputLimit = 131072, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    emitProgress(onProgress, 'provider_running', 'Atomic Mail CLI is running; registration and proof-of-work are in progress');
    let lastPhase = 'provider_running';
    let lastMessage = 'Atomic Mail CLI is running; registration and proof-of-work are in progress';
    const heartbeatTimer = setInterval(() => {
      emitProgress(onProgress, lastPhase, lastMessage);
    }, 2000);
    heartbeatTimer.unref?.();

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer = null;

    const append = (current, chunk) => {
      if (current.length >= outputLimit) return current;
      return (current + chunk.toString('utf8')).slice(0, outputLimit);
    };

    const cleanup = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      clearInterval(heartbeatTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const terminate = (reason) => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
      }, 2000);
      forceKillTimer.unref();
    };

    const onAbort = () => terminate('abort');

    const handleProgressOutput = (chunk) => {
      const detected = progressFromOutput(chunk);
      if (!detected) return;
      [lastPhase, lastMessage] = detected;
      emitProgress(onProgress, lastPhase, lastMessage);
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      handleProgressOutput(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
      handleProgressOutput(chunk);
    });

    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ code, signal: closeSignal, stdout, stderr, timedOut, aborted });
    });
  });
}

export class AtomicMailProvider {
  constructor(config, vault) {
    this.config = config;
    this.vault = vault;
    this.activeAbortController = null;
  }

  abortActive() {
    this.activeAbortController?.abort();
  }

  existingMailbox(username) {
    if (!this.vault?.hasCredentials(username)) return null;
    const existing = this.vault.readCredentials(username);
    if (!this.vault.validateCredentials(username, existing)) {
      throw new ProviderError('Encrypted credential vault does not match the requested username', {
        kind: 'policy',
        raw: 'Credential vault mismatch; refusing to overwrite provider credentials',
      });
    }
    const identity = this.vault.credentialIdentity(username, existing);
    return {
      username,
      email: identity.email,
      inboxId: identity.inboxId,
      credentialsPath: this.vault.credentialsPath(username),
    };
  }

  async register(username, { onProgress } = {}) {
    emitProgress(onProgress, 'preparing', 'Preparing encrypted credential workspace');

    // Crash-safe idempotency now reads the encrypted permanent vault. A
    // completed registration is never repeated merely because the DB commit
    // was interrupted.
    const existing = this.existingMailbox(username);
    if (existing) {
      emitProgress(onProgress, 'recovered', 'Encrypted provider credentials found; reusing crash-safe registration');
      return existing;
    }

    // The official AgentSkill requires a normal credential directory while it
    // is running. Plaintext therefore exists only inside an isolated temporary
    // runtime directory and is sealed into AES-256-GCM storage immediately
    // after the process exits. Stale runtime directories are recovered/sealed
    // on the next panel start after a hard crash.
    const runtimeDir = this.vault.createRuntimeDir(username);
    const env = {
      ...process.env,
      ATOMIC_MAIL_CREDENTIALS_DIR: runtimeDir,
      ATOMIC_MAIL_AUTH_URL: this.config.atomicAuthUrl,
      ATOMIC_MAIL_API_URL: this.config.atomicApiUrl,
      NO_COLOR: '1',
    };
    const args = [
      ...this.config.atomicCliPrefixArgs,
      'register',
      '--username',
      username,
      '--watch',
      this.config.atomicWatchMode || 'on-demand',
    ];

    const controller = new AbortController();
    this.activeAbortController = controller;

    let result;
    let spawnError = null;
    try {
      emitProgress(onProgress, 'launching', 'Starting official Atomic Mail AgentSkill');
      const invocation = resolveProviderInvocation(this.config.atomicCliCommand, args);
      result = await runProcess(invocation.command, invocation.args, {
        env,
        timeoutMs: this.config.registerTimeoutMs,
        signal: controller.signal,
        onProgress,
      });
    } catch (error) {
      spawnError = error;
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = null;
    }

    // If AgentSkill managed to persist a complete API-key credential before a
    // timeout/abort/CLI error, preserve it in the encrypted vault. The worker
    // may still classify this attempt as interrupted, but the next attempt will
    // safely reuse the already-created inbox instead of signing up again.
    let sealed = null;
    try {
      sealed = this.vault.sealRuntimeDir(username, runtimeDir, { requireUsableCredentials: true });
    } catch (error) {
      this.vault.discardRuntime(runtimeDir);
      throw new ProviderError('Atomic Mail credentials were created but could not be sealed safely', {
        kind: 'permanent',
        raw: redactSecrets(error?.message || String(error)),
      });
    }

    if (spawnError) {
      if (!sealed) this.vault.discardRuntime(runtimeDir);
      const classified = classifyProviderError(spawnError?.message || String(spawnError));
      throw new ProviderError(classified.message, {
        ...classified,
        raw: redactSecrets(spawnError?.message || String(spawnError)),
      });
    }

    const combined = redactSecrets(`${result.stdout}\n${result.stderr}`.trim());
    if (result.aborted) {
      if (!sealed) this.vault.discardRuntime(runtimeDir);
      throw new ProviderError('Atomic Mail registration was interrupted by controlled shutdown', {
        kind: 'interrupted',
        raw: 'registration interrupted by operator shutdown',
      });
    }
    if (result.timedOut) {
      if (!sealed) this.vault.discardRuntime(runtimeDir);
      throw new ProviderError('Atomic Mail registration process timed out', {
        kind: 'transient',
        raw: combined || 'registration timeout',
      });
    }
    if (result.code !== 0) {
      if (!sealed) this.vault.discardRuntime(runtimeDir);
      const classified = classifyProviderError(combined || `CLI exited with code ${result.code}, signal ${result.signal || 'none'}`);
      throw new ProviderError(classified.message, { ...classified, raw: combined });
    }

    emitProgress(onProgress, 'validating', 'Registration returned successfully; validating encrypted credentials');
    if (!sealed) {
      this.vault.discardRuntime(runtimeDir);
      throw new ProviderError('Atomic Mail CLI exited successfully but complete credentials were not created', {
        kind: 'transient',
        raw: combined,
      });
    }

    const credentials = sealed.credentials;
    const identity = this.vault.credentialIdentity(username, credentials);
    emitProgress(onProgress, 'finalizing', 'Credentials encrypted and validated; saving mailbox in the panel');
    return {
      username,
      email: identity.email,
      inboxId: identity.inboxId,
      credentialsPath: sealed.credentialsPath,
    };
  }
}
