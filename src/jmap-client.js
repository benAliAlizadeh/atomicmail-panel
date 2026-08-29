import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@atomicmail/agent-skill/esm/_dnt.polyfills.js';
import { resolveProviderInvocation } from './provider.js';
import { redactSecrets } from './utils.js';
import { selectCloudflareVerification } from './cloudflare-verification.js';
import { createAgentSession } from '@atomicmail/agent-skill/esm/lib/integrations/create-agent-session.js';
import {
  DEFAULT_JMAP_USING,
  readOpsFile,
  runJmapRequest,
} from '@atomicmail/agent-skill/esm/lib/agent/jmap/agent-jmap.js';
import { JmapRequestCoordinator } from './jmap-coordinator.js';

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class MailClientError extends Error {
  constructor(message, { statusCode = 502, code = 'mail_provider_error', retryAfterMs = 0, retryAt = null } = {}) {
    super(message);
    this.name = 'MailClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.retryAt = retryAt || null;
    this.expose = true;
  }
}

class EncryptedCredentialStore {
  constructor(vault, username) {
    this.vault = vault;
    this.username = username;
  }

  optional(relative) {
    try {
      return this.vault.readEncryptedFile(this.username, relative).toString('utf8').trim() || undefined;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async load() {
    return {
      credentials: this.vault.readCredentials(this.username),
      sessionJwt: this.optional('session.jwt'),
      capabilityJwt: this.optional('capability.jwt'),
    };
  }

  async save(artifacts) {
    if (artifacts.credentials !== undefined) {
      this.vault.writeEncryptedFile(
        this.username,
        'credentials.json',
        Buffer.from(`${JSON.stringify(artifacts.credentials, null, 2)}\n`, 'utf8'),
      );
    }
    if (artifacts.sessionJwt !== undefined) {
      this.vault.writeEncryptedFile(this.username, 'session.jwt', Buffer.from(String(artifacts.sessionJwt), 'utf8'));
    }
    if (artifacts.capabilityJwt !== undefined) {
      this.vault.writeEncryptedFile(this.username, 'capability.jwt', Buffer.from(String(artifacts.capabilityJwt), 'utf8'));
    }
  }

  async clear() {
    throw new Error('Credential removal is not available through the mail session cache');
  }
}

function runCliProcess(command, args, { env, timeoutMs, outputLimit = DEFAULT_OUTPUT_LIMIT, signal = null } = {}) {
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
    let aborted = false;
    let forceKillTimer = null;

    const append = (current, chunk) => {
      if (current.length >= outputLimit) return current;
      return (current + chunk.toString('utf8')).slice(0, outputLimit);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abortProcess);
    };
    const terminate = () => {
      if (settled) return;
      try { child.kill('SIGTERM'); } catch {}
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 2000);
      forceKillTimer.unref?.();
    };
    const abortProcess = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abortProcess, { once: true });
    if (signal?.aborted) abortProcess();

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    });
  });
}

function safeJson(text) {
  try { return JSON.parse(String(text || '').trim()); } catch { return null; }
}

function safeProviderDetail(input, { vars = null, paths = [] } = {}) {
  let safe = redactSecrets(String(input || ''));
  const privateValues = vars && typeof vars === 'object' ? Object.values(vars) : [];
  for (const value of privateValues) {
    const text = String(value || '');
    if (text.length >= 4) safe = safe.replaceAll(text, '[REQUEST_VALUE_REDACTED]');
  }
  for (const value of paths) {
    const text = String(value || '');
    if (text) safe = safe.replaceAll(text, '[RUNTIME_PATH_REDACTED]');
  }
  return safe;
}

function methodResponse(body, methodName, callId = null) {
  const responses = Array.isArray(body?.methodResponses) ? body.methodResponses : [];
  const row = responses.find((entry) => (
    Array.isArray(entry) && entry[0] === methodName && (callId == null || entry[2] === callId)
  ));
  return row?.[1] || null;
}

function firstMethodError(body) {
  const responses = Array.isArray(body?.methodResponses) ? body.methodResponses : [];
  for (const entry of responses) {
    if (!Array.isArray(entry)) continue;
    if (entry[0] === 'error') {
      const detail = entry[1] || {};
      return String(detail.description || detail.type || 'JMAP method failed');
    }
    const payload = entry[1];
    if (payload && typeof payload === 'object') {
      const notCreated = payload.notCreated && Object.values(payload.notCreated)[0];
      const notUpdated = payload.notUpdated && Object.values(payload.notUpdated)[0];
      const notDestroyed = payload.notDestroyed && Object.values(payload.notDestroyed)[0];
      const problem = notCreated || notUpdated || notDestroyed;
      if (problem) return String(problem.description || problem.type || `${entry[0]} failed`);
    }
  }
  return null;
}

function cleanAddressList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.email === 'string')
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name.slice(0, 300) : '',
      email: entry.email.slice(0, 320),
    }));
}

function addressText(addresses) {
  return cleanAddressList(addresses).map((entry) => entry.name ? `${entry.name} <${entry.email}>` : entry.email).join(', ');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

export function htmlToSafeText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function extractSafeLinks(text, html = '') {
  const links = new Set();
  const add = (candidate) => {
    const decoded = decodeHtmlEntities(String(candidate || '').trim());
    try {
      const parsed = new URL(decoded);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') links.add(parsed.href);
    } catch {}
  };
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRe.exec(String(html || ''))) && links.size < 30) add(match[1]);
  const urlRe = /https?:\/\/[^\s<>()"']+/gi;
  for (const raw of String(text || '').match(urlRe) || []) {
    if (links.size >= 30) break;
    add(raw.replace(/[.,;!?]+$/, ''));
  }
  return [...links];
}

export function extractVerificationCodes(text) {
  const source = String(text || '').replace(/\s+/g, ' ');
  const codes = new Set();
  const patterns = [
    /(?:verification|verify|security|login|one[- ]time|otp|passcode|auth(?:entication)?)(?:\s+(?:code|pin|number))?\s*(?:is|:|-)?\s*([A-Z0-9][A-Z0-9-]{2,10}[A-Z0-9])/giu,
    /(?:code|pin|passcode)\s*(?:is|:|-)?\s*([0-9]{4,8})/giu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const code = String(match[1] || '').replaceAll('-', '');
      if (/^(?=.*\d)[A-Z0-9]{4,10}$/i.test(code)) codes.add(code);
      if (codes.size >= 10) return [...codes];
    }
  }
  return [...codes];
}

export function extractVerificationLinks(links) {
  return (Array.isArray(links) ? links : []).filter((link) => {
    try {
      const parsed = new URL(String(link));
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      return /(?:verify|verification|confirm|activate|validate|token|magic|auth|login|reset)/i.test(`${parsed.pathname}${parsed.search}`);
    } catch {
      return false;
    }
  }).slice(0, 20);
}

function bodyPartValues(parts, values) {
  if (!Array.isArray(parts) || !values || typeof values !== 'object') return '';
  const output = [];
  for (const part of parts) {
    const partId = part?.partId;
    if (typeof partId !== 'string') continue;
    const value = values[partId]?.value;
    if (typeof value === 'string' && value) output.push(value);
  }
  return output.join('\n\n').trim();
}

function normalizeAttachments(row) {
  if (!Array.isArray(row?.attachments)) return [];
  return row.attachments.slice(0, 100).map((attachment, index) => ({
    id: String(index),
    name: String(attachment?.name || `attachment-${index + 1}`).slice(0, 255),
    type: String(attachment?.type || 'application/octet-stream').slice(0, 255),
    size: Math.max(0, Number(attachment?.size) || 0),
    disposition: String(attachment?.disposition || 'attachment').slice(0, 32),
  }));
}

function normalizedMessage(row) {
  const bodyValues = row?.bodyValues || {};
  const textBody = bodyPartValues(row?.textBody, bodyValues);
  const htmlBody = bodyPartValues(row?.htmlBody, bodyValues);
  const fallbackBody = textBody || htmlToSafeText(htmlBody) || String(row?.preview || '');
  const truncated = Object.values(bodyValues).some((value) => Boolean(value?.isTruncated));
  const links = extractSafeLinks(`${fallbackBody}\n${textBody}`, htmlBody);
  const attachments = normalizeAttachments(row);
  return {
    id: String(row?.id || ''),
    threadId: String(row?.threadId || ''),
    messageId: Array.isArray(row?.messageId) ? row.messageId.map(String) : [],
    inReplyTo: Array.isArray(row?.inReplyTo) ? row.inReplyTo.map(String) : [],
    from: cleanAddressList(row?.from),
    to: cleanAddressList(row?.to),
    cc: cleanAddressList(row?.cc),
    replyTo: cleanAddressList(row?.replyTo),
    fromText: addressText(row?.from),
    toText: addressText(row?.to),
    ccText: addressText(row?.cc),
    subject: String(row?.subject || '(no subject)'),
    receivedAt: row?.receivedAt || null,
    sentAt: row?.sentAt || null,
    preview: String(row?.preview || ''),
    body: fallbackBody,
    bodyTruncated: truncated,
    hasAttachment: Boolean(row?.hasAttachment) || attachments.length > 0,
    attachmentCount: attachments.length,
    attachments,
    links,
    verificationCodes: extractVerificationCodes(`${fallbackBody}\n${row?.subject || ''}`),
    verificationLinks: extractVerificationLinks(links),
    unread: !Boolean(row?.keywords?.$seen),
  };
}

function normalizeListMessage(row) {
  return {
    id: String(row?.id || ''),
    threadId: String(row?.threadId || ''),
    from: cleanAddressList(row?.from),
    fromText: addressText(row?.from),
    to: cleanAddressList(row?.to),
    toText: addressText(row?.to),
    subject: String(row?.subject || '(no subject)'),
    receivedAt: row?.receivedAt || null,
    sentAt: row?.sentAt || null,
    preview: String(row?.preview || ''),
    unread: !Boolean(row?.keywords?.$seen),
    hasAttachment: Boolean(row?.hasAttachment),
  };
}

function assertEmail(value) {
  const email = String(value || '').trim();
  if (email.length > 320 || !EMAIL_RE.test(email)) {
    throw new MailClientError('Recipient email address is invalid', { statusCode: 400, code: 'invalid_recipient' });
  }
  return email;
}

function assertText(value, name, { max, required = true } = {}) {
  const text = String(value ?? '').replace(/\u0000/g, '');
  if (required && !text.trim()) throw new MailClientError(`${name} is required`, { statusCode: 400, code: 'invalid_message' });
  if (max && Buffer.byteLength(text, 'utf8') > max) {
    throw new MailClientError(`${name} is too large`, { statusCode: 413, code: 'message_too_large' });
  }
  return text;
}

function assertHeaderText(value, name, options = {}) {
  const text = assertText(value, name, options);
  if (/\r|\n/.test(text)) {
    throw new MailClientError(`${name} cannot contain line breaks`, { statusCode: 400, code: 'invalid_header' });
  }
  return text;
}

function jmapPatchEscape(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function safeAttachmentFilename(value, index = 0) {
  const cleaned = path.basename(String(value || ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .slice(0, 180);
  return cleaned || `attachment-${index + 1}.bin`;
}

export class AtomicMailJmapClient {
  constructor(config, vault, {
    runner = null,
    coordinator = null,
    sessionFactory = createAgentSession,
    jmapExecutor = runJmapRequest,
    opsReader = readOpsFile,
  } = {}) {
    this.config = config;
    this.vault = vault;
    this.runner = runner || runCliProcess;
    this.legacyRunner = Boolean(runner);
    this.sessionFactory = sessionFactory;
    this.jmapExecutor = jmapExecutor;
    this.opsReader = opsReader;
    this.sessions = new Map();
    this.queues = new Map();
    this.mailboxRoleCache = new Map();
    this.coordinator = coordinator || new JmapRequestCoordinator({
      executor: (username, operation, context) => this.executeDirect(username, operation, context),
      maxRetries: Number(this.config.jmapMaxRetries ?? 3),
      baseDelayMs: Number(this.config.jmapRetryBaseMs || 1000),
      maxDelayMs: Number(this.config.jmapRetryMaxMs || 30000),
      minIntervalMs: Number(this.config.jmapGlobalMinIntervalMs || 500),
    });
  }

  enqueue(username, task) {
    const prior = this.queues.get(username) || Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    let tracked;
    tracked = next.finally(() => {
      if (this.queues.get(username) === tracked) this.queues.delete(username);
    });
    this.queues.set(username, tracked);
    return tracked;
  }

  async getSession(username) {
    if (!this.sessions.has(username)) {
      const pending = this.sessionFactory({
        store: new EncryptedCredentialStore(this.vault, username),
        credentialDir: `encrypted-vault://${username}`,
        env: {
          authUrl: this.config.atomicAuthUrl,
          apiUrl: this.config.atomicApiUrl,
          scryptSalt: this.config.atomicScryptSalt,
        },
      }).catch((error) => {
        this.sessions.delete(username);
        throw error;
      });
      this.sessions.set(username, pending);
    }
    return this.sessions.get(username);
  }

  async executeDirect(username, operation, { signal = null } = {}) {
    if (signal?.aborted) throw new MailClientError('Mail request was cancelled', { statusCode: 499, code: 'mail_cancelled' });
    const {
      ops = null,
      opsFile = null,
      vars = null,
      attachments = [],
      outputLimit = DEFAULT_OUTPUT_LIMIT,
    } = operation;
    let attachmentDir = null;
    try {
      let attachmentInputs = [];
      if (attachments.length) {
        const runtimeRoot = this.config.runtimeCredentialsRoot || os.tmpdir();
        fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
        attachmentDir = fs.mkdtempSync(path.join(runtimeRoot, 'mail-attachments-'));
        const usedNames = new Set();
        attachmentInputs = attachments.map((attachment, index) => {
          let filename = safeAttachmentFilename(attachment?.name, index);
          if (usedNames.has(filename.toLowerCase())) {
            const extension = path.extname(filename);
            filename = `${path.basename(filename, extension).slice(0, 160)}-${index + 1}${extension}`;
          }
          usedNames.add(filename.toLowerCase());
          const filePath = path.join(attachmentDir, filename);
          fs.writeFileSync(filePath, Buffer.from(attachment.data), { mode: 0o600 });
          return { path: filePath, filename, contentType: attachment.type || undefined };
        });
      }
      const session = await this.getSession(username);
      const opsJson = opsFile
        ? await this.opsReader(process.cwd(), opsFile)
        : (typeof ops === 'string' ? ops : JSON.stringify(ops));
      const result = await this.jmapExecutor({
        session,
        opsJson,
        defaultUsing: [...DEFAULT_JMAP_USING],
        sourceLabel: opsFile || 'inline JMAP operations',
        vars: vars || undefined,
        attachments: attachmentInputs,
        attachmentPathBase: attachmentDir || process.cwd(),
      });
      if (!result.ok) {
        const detail = safeProviderDetail(result.bodyText, { vars, paths: [attachmentDir] }).slice(0, 700);
        const error = new MailClientError(`Atomic Mail JMAP request failed (HTTP ${result.status})${detail ? `: ${detail}` : ''}`, {
          statusCode: Number(result.status) || 502,
          code: Number(result.status) === 429 ? 'mail_rate_limited' : 'mail_provider_error',
        });
        if (Number(result.status) === 401) {
          session.invalidateJmapSessionCache?.();
          this.sessions.delete(username);
        }
        throw error;
      }
      if (Buffer.byteLength(String(result.bodyText || ''), 'utf8') > Math.max(1024, Number(outputLimit) || DEFAULT_OUTPUT_LIMIT)) {
        throw new MailClientError('Atomic Mail returned a JMAP response larger than the safety limit', {
          statusCode: 502, code: 'mail_response_too_large',
        });
      }
      const body = safeJson(result.bodyText);
      if (!body || typeof body !== 'object') throw new MailClientError('Atomic Mail returned an invalid JMAP response');
      const methodError = firstMethodError(body);
      if (methodError) {
        const detail = safeProviderDetail(methodError, { vars }).slice(0, 500);
        throw new MailClientError(`Atomic Mail rejected the mail operation: ${detail}`, { statusCode: 422, code: 'jmap_method_error' });
      }
      return body;
    } catch (error) {
      if (signal?.aborted) throw new MailClientError('Mail request was cancelled', { statusCode: 499, code: 'mail_cancelled' });
      if (error instanceof MailClientError) throw error;
      const detail = safeProviderDetail(error?.message || String(error), { vars, paths: [attachmentDir] });
      const status = Number(String(error?.message || '').match(/HTTP\s+(\d{3})\b/i)?.[1] || 0);
      throw new MailClientError(`Atomic Mail mail request failed${detail ? `: ${detail.slice(0, 700)}` : ''}`, {
        statusCode: status || 502,
        code: status === 429 ? 'mail_rate_limited' : 'mail_provider_error',
      });
    } finally {
      if (attachmentDir) {
        try { fs.rmSync(attachmentDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  async request(username, options) {
    if (this.legacyRunner) return this.requestViaCli(username, options);
    const priority = options.priority === 'background' ? 'background' : 'interactive';
    return this.coordinator.schedule(username, options, {
      priority,
      signal: options.signal || null,
      coalesceKey: options.coalesceKey || '',
    });
  }

  async requestViaCli(username, { ops = null, opsFile = null, vars = null, attachments = [], outputLimit = DEFAULT_OUTPUT_LIMIT, signal = null }) {
    return this.enqueue(username, async () => {
      if (signal?.aborted) {
        throw new MailClientError('Mail request was cancelled', { statusCode: 499, code: 'mail_cancelled' });
      }
      const runtimeDir = this.vault.materialize(username);
      let attachmentDir = null;
      const cleanupAttachments = () => {
        if (!attachmentDir) return;
        try { fs.rmSync(attachmentDir, { recursive: true, force: true }); } catch {}
        attachmentDir = null;
      };
      const env = {
        ...process.env,
        ATOMIC_MAIL_CREDENTIALS_DIR: runtimeDir,
        NO_COLOR: '1',
      };
      const args = [
        ...this.config.atomicCliPrefixArgs,
        'jmap_request',
        '--credentials-dir',
        runtimeDir,
      ];
      if (opsFile) args.push('--ops-file', opsFile);
      else args.push('--ops', typeof ops === 'string' ? ops : JSON.stringify(ops));
      if (vars && Object.keys(vars).length) args.push('--vars', JSON.stringify(vars));

      if (attachments.length) {
        try {
          const runtimeRoot = this.config.runtimeCredentialsRoot || os.tmpdir();
          fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
          attachmentDir = fs.mkdtempSync(path.join(runtimeRoot, 'mail-attachments-'));
          const usedNames = new Set();
          attachments.forEach((attachment, index) => {
            let filename = safeAttachmentFilename(attachment?.name, index);
            if (usedNames.has(filename.toLowerCase())) {
              const extension = path.extname(filename);
              filename = `${path.basename(filename, extension).slice(0, 160)}-${index + 1}${extension}`;
            }
            usedNames.add(filename.toLowerCase());
            const filePath = path.join(attachmentDir, filename);
            fs.writeFileSync(filePath, Buffer.from(attachment.data), { mode: 0o600 });
            args.push('--attachment', filePath);
          });
        } catch (error) {
          this.vault.discardRuntime(runtimeDir);
          cleanupAttachments();
          throw new MailClientError('Could not prepare attachments safely', { statusCode: 500, code: 'attachment_prepare_failed' });
        }
      }

      let result;
      try {
        const invocation = resolveProviderInvocation(this.config.atomicCliCommand, args);
        result = await this.runner(invocation.command, invocation.args, {
          env,
          timeoutMs: this.config.mailCommandTimeoutMs,
          outputLimit,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          this.vault.discardRuntime(runtimeDir);
          cleanupAttachments();
          throw new MailClientError('Mail request was cancelled', { statusCode: 499, code: 'mail_cancelled' });
        }
        const detail = safeProviderDetail(error?.message || String(error), { vars, paths: [runtimeDir, attachmentDir] });
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError(`Could not start Atomic Mail mail command: ${detail}`);
      }

      if (result.aborted || signal?.aborted) {
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError('Mail request was cancelled', { statusCode: 499, code: 'mail_cancelled' });
      }
      if (result.timedOut) {
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError('Atomic Mail mail request timed out', { statusCode: 504, code: 'mail_timeout' });
      }
      if (result.code !== 0) {
        const detail = safeProviderDetail(
          String(result.stderr || result.stdout || `CLI exited with code ${result.code}`),
          { vars, paths: [runtimeDir, attachmentDir] },
        ).trim();
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError(`Atomic Mail mail request failed${detail ? `: ${detail.slice(0, 700)}` : ''}`);
      }

      const body = safeJson(result.stdout);
      if (!body || typeof body !== 'object') {
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError('Atomic Mail returned an invalid JMAP response');
      }

      try {
        const sealed = this.vault.commitRuntime(username, runtimeDir);
        if (!sealed) throw new Error('runtime credentials were not complete');
      } catch (error) {
        const detail = safeProviderDetail(error?.message || String(error), { vars, paths: [runtimeDir, attachmentDir] });
        this.vault.discardRuntime(runtimeDir);
        cleanupAttachments();
        throw new MailClientError(`Mail request succeeded but refreshed credentials could not be encrypted: ${detail}`);
      }

      cleanupAttachments();

      const methodError = firstMethodError(body);
      if (methodError) {
        const detail = safeProviderDetail(methodError, { vars }).slice(0, 500);
        throw new MailClientError(`Atomic Mail rejected the mail operation: ${detail}`, { statusCode: 422, code: 'jmap_method_error' });
      }
      return body;
    });
  }

  async mailboxIdForRole(username, role, { required = true, signal = null, priority = 'interactive' } = {}) {
    const safeRole = String(role || '').toLowerCase();
    if (!['inbox', 'sent', 'trash', 'archive'].includes(safeRole)) {
      throw new MailClientError('Mailbox folder is invalid', { statusCode: 400, code: 'invalid_mailbox' });
    }
    const key = `${username}:${safeRole}`;
    if (this.mailboxRoleCache.has(key)) return this.mailboxRoleCache.get(key);
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Mailbox/query', {
        accountId: '$ACCOUNT_ID',
        filter: { role: safeRole },
        limit: 1,
      }, 'mq0']],
    };
    const result = await this.request(username, {
      ops,
      signal,
      priority,
      coalesceKey: priority === 'background' ? `mailbox-role:${safeRole}` : '',
    });
    const payload = methodResponse(result, 'Mailbox/query', 'mq0') || {};
    const id = Array.isArray(payload.ids) ? String(payload.ids[0] || '') : '';
    if (!id && required) throw new MailClientError(`${safeRole} mailbox is unavailable`, { statusCode: 422, code: 'mailbox_unavailable' });
    this.mailboxRoleCache.set(key, id);
    return id;
  }

  async listMailbox(username, { folder = 'inbox', limit = 50, position = 0, search = '', field = 'subject', signal = null } = {}) {
    const safeFolder = String(folder || 'inbox').toLowerCase();
    if (!['inbox', 'sent'].includes(safeFolder)) {
      throw new MailClientError('Mailbox folder is invalid', { statusCode: 400, code: 'invalid_mailbox' });
    }
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const safePosition = Math.max(0, Number(position) || 0);
    const safeField = String(field || 'subject').toLowerCase();
    if (!['subject', 'from', 'to'].includes(safeField)) {
      throw new MailClientError('Search field is invalid', { statusCode: 400, code: 'invalid_search' });
    }
    const safeSearch = assertText(search, 'Search query', {
      max: this.config.mailMaxSearchBytes || 256,
      required: false,
    }).trim();
    const mailboxId = safeFolder === 'inbox' && this.legacyRunner
      ? '$INBOX_MAILBOX_ID'
      : await this.mailboxIdForRole(username, safeFolder, { signal });
    const filter = { inMailbox: mailboxId };
    if (safeSearch) filter[safeField] = safeSearch;
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: '$ACCOUNT_ID',
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position: safePosition,
          limit: safeLimit,
          calculateTotal: true,
        }, 'q0'],
        ['Email/get', {
          accountId: '$ACCOUNT_ID',
          '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'threadId', 'receivedAt', 'sentAt', 'from', 'to', 'subject', 'preview', 'keywords', 'hasAttachment'],
        }, 'g0'],
        ['Email/query', {
          accountId: '$ACCOUNT_ID',
          filter: { ...filter, notKeyword: '$seen' },
          limit: 0,
          calculateTotal: true,
        }, 'uq0'],
      ],
    };
    const result = await this.request(username, { ops, signal });
    const query = methodResponse(result, 'Email/query', 'q0') || {};
    const get = methodResponse(result, 'Email/get', 'g0') || {};
    const unreadQuery = methodResponse(result, 'Email/query', 'uq0') || {};
    return {
      total: Number(query.total ?? query.ids?.length ?? 0),
      unreadTotal: Number(unreadQuery.total ?? unreadQuery.ids?.length ?? 0),
      position: safePosition,
      limit: safeLimit,
      folder: safeFolder,
      state: String(query.queryState || get.state || ''),
      syncedAt: new Date().toISOString(),
      items: Array.isArray(get.list) ? get.list.map(normalizeListMessage) : [],
    };
  }

  async listInbox(username, options = {}) {
    return this.listMailbox(username, { ...options, folder: 'inbox' });
  }

  async findCloudflareVerification(username, { recipient, submittedAt, signal = null, priority = 'background' } = {}) {
    const afterMs = Date.parse(submittedAt || '');
    if (!Number.isFinite(afterMs)) {
      throw new MailClientError('Cloudflare submission timestamp is invalid', { statusCode: 400, code: 'invalid_verification_window' });
    }
    const inboxMailboxId = this.legacyRunner
      ? '$INBOX_MAILBOX_ID'
      : await this.mailboxIdForRole(username, 'inbox', { signal, priority });
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: '$ACCOUNT_ID',
          filter: {
            inMailbox: inboxMailboxId,
            after: new Date(afterMs).toISOString(),
          },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: 20,
        }, 'cfq0'],
        ['Email/get', {
          accountId: '$ACCOUNT_ID',
          '#ids': { resultOf: 'cfq0', name: 'Email/query', path: '/ids' },
          properties: [
            'id', 'receivedAt', 'from', 'to', 'cc', 'subject', 'preview',
            'textBody', 'htmlBody', 'bodyValues',
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: Math.min(Number(this.config.mailMaxBodyBytes || 524288), 262144),
        }, 'cfg0'],
      ],
    };
    const result = await this.request(username, {
      ops,
      signal,
      priority,
      coalesceKey: priority === 'background' ? `cloudflare-verification:${new Date(afterMs).toISOString()}` : '',
    });
    const payload = methodResponse(result, 'Email/get', 'cfg0') || {};
    const messages = Array.isArray(payload.list) ? payload.list.map(normalizedMessage) : [];
    return selectCloudflareVerification(messages, { recipient, submittedAt });
  }

  async getMessage(username, messageId, { signal = null } = {}) {
    const id = assertText(messageId, 'messageId', { max: 1024 });
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [[
        'Email/get',
        {
          accountId: '$ACCOUNT_ID',
          ids: ['$MAIL_ID'],
          properties: [
            'id', 'threadId', 'receivedAt', 'sentAt', 'from', 'to', 'cc', 'replyTo',
            'subject', 'preview', 'messageId', 'inReplyTo', 'keywords', 'hasAttachment',
            'textBody', 'htmlBody', 'bodyValues', 'attachments',
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: this.config.mailMaxBodyBytes,
        },
        'g0',
      ]],
    };
    const result = await this.request(username, { ops, vars: { MAIL_ID: id }, signal });
    const payload = methodResponse(result, 'Email/get') || {};
    const row = Array.isArray(payload.list) ? payload.list[0] : null;
    if (!row) throw new MailClientError('Email message was not found', { statusCode: 404, code: 'message_not_found' });
    return normalizedMessage(row);
  }

  async send(username, { to, subject, body, attachments = [] }) {
    const vars = {
      TO: assertEmail(to),
      SUBJECT: assertHeaderText(subject, 'Subject', { max: this.config.mailMaxSubjectBytes, required: false }),
      BODY: assertText(body, 'Message body', { max: this.config.mailMaxComposeBytes }),
    };
    const ops = attachments.length ? this.attachmentSendOps(attachments.length, false) : null;
    const result = await this.request(username, attachments.length
      ? { ops, vars, attachments }
      : { opsFile: 'send_mail.json', vars });
    const emailSet = methodResponse(result, 'Email/set') || {};
    const submission = methodResponse(result, 'EmailSubmission/set') || {};
    return {
      emailId: emailSet.created?.d1?.id || emailSet.created?.m1?.id || null,
      submissionId: submission.created?.s1?.id || null,
      to: vars.TO,
    };
  }

  async reply(username, messageId, { body, attachments = [] }) {
    const vars = {
      MAIL_ID: assertText(messageId, 'messageId', { max: 1024 }),
      BODY: assertText(body, 'Reply body', { max: this.config.mailMaxComposeBytes }),
    };
    const ops = attachments.length ? this.attachmentSendOps(attachments.length, true) : null;
    const result = await this.request(username, attachments.length
      ? { ops, vars, attachments }
      : { opsFile: 'reply.json', vars });
    const emailSet = methodResponse(result, 'Email/set') || {};
    const submission = methodResponse(result, 'EmailSubmission/set') || {};
    return {
      emailId: emailSet.created?.d1?.id || emailSet.created?.m1?.id || null,
      submissionId: submission.created?.s1?.id || null,
    };
  }

  attachmentSendOps(count, reply) {
    const attachmentParts = Array.from({ length: count }, (_, index) => ({
      blobId: `$ATTACHMENT_${index}_BLOB_ID`,
      type: `$ATTACHMENT_${index}_TYPE`,
      name: `$ATTACHMENT_${index}_NAME`,
    }));
    const message = {
      mailboxIds: { '$INBOX_MAILBOX_ID': true },
      from: [{ email: '$INBOX' }],
      subject: '$SUBJECT',
      textBody: [{ partId: 'b', type: 'text/plain' }],
      bodyValues: { b: { value: '$BODY' } },
      attachments: attachmentParts,
      keywords: { '$draft': true },
    };
    const methodCalls = [];
    if (reply) {
      delete message.subject;
      methodCalls.push(['Email/get', {
        accountId: '$ACCOUNT_ID', ids: ['$MAIL_ID'],
        properties: ['id', 'from', 'replyTo', 'subject', 'messageId'],
      }, 'g0']);
      message['#to'] = { resultOf: 'g0', name: 'Email/get', path: '/list/0/replyTo' };
      message['#subject'] = { resultOf: 'g0', name: 'Email/get', path: '/list/0/subject' };
      message['#inReplyTo'] = { resultOf: 'g0', name: 'Email/get', path: '/list/0/messageId' };
    } else {
      message.to = [{ email: '$TO' }];
    }
    methodCalls.push(['Email/set', { accountId: '$ACCOUNT_ID', create: { m1: message } }, 'm0']);
    const envelope = reply
      ? { mailFrom: { email: '$INBOX' }, '#rcptTo': { resultOf: 'g0', name: 'Email/get', path: '/list/0/replyTo' } }
      : { mailFrom: { email: '$INBOX' }, rcptTo: [{ email: '$TO' }] };
    methodCalls.push(['EmailSubmission/set', {
      accountId: '$ACCOUNT_ID', create: { s1: { emailId: '#m1', envelope } },
    }, 's0']);
    return {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls,
    };
  }

  async updateMessage(username, messageId, action) {
    const id = assertText(messageId, 'messageId', { max: 1024 });
    const safeAction = String(action || '').toLowerCase();
    if (!['mark_read', 'mark_unread', 'archive', 'trash'].includes(safeAction)) {
      throw new MailClientError('Mail action is invalid', { statusCode: 400, code: 'invalid_mail_action' });
    }
    const patch = {};
    if (safeAction === 'mark_read') patch['keywords/$seen'] = true;
    if (safeAction === 'mark_unread') patch['keywords/$seen'] = null;
    if (safeAction === 'archive') {
      const archiveId = await this.mailboxIdForRole(username, 'archive', { required: false });
      if (archiveId) patch.mailboxIds = { [archiveId]: true };
      else patch['mailboxIds/$INBOX_MAILBOX_ID'] = null;
    }
    if (safeAction === 'trash') {
      const trashId = await this.mailboxIdForRole(username, 'trash');
      patch.mailboxIds = { [trashId]: true };
    }
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/set', {
        accountId: '$ACCOUNT_ID',
        update: { [id]: patch },
      }, 'u0']],
    };
    const result = await this.request(username, { ops });
    const payload = methodResponse(result, 'Email/set', 'u0') || {};
    return { id, action: safeAction, updated: Array.isArray(payload.updated) ? payload.updated.includes(id) : true };
  }

  async downloadAttachment(username, messageId, attachmentId, { signal = null } = {}) {
    const id = assertText(messageId, 'messageId', { max: 1024 });
    const index = Number.parseInt(String(attachmentId), 10);
    if (!Number.isInteger(index) || index < 0 || index > 99) {
      throw new MailClientError('Attachment was not found', { statusCode: 404, code: 'attachment_not_found' });
    }
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/get', {
        accountId: '$ACCOUNT_ID', ids: ['$MAIL_ID'], properties: ['id', 'attachments'],
      }, 'g0']],
    };
    const messageResult = await this.request(username, { ops, vars: { MAIL_ID: id }, signal });
    const row = methodResponse(messageResult, 'Email/get', 'g0')?.list?.[0];
    const attachment = Array.isArray(row?.attachments) ? row.attachments[index] : null;
    const blobId = typeof attachment?.blobId === 'string' ? attachment.blobId : '';
    if (!blobId) throw new MailClientError('Attachment was not found', { statusCode: 404, code: 'attachment_not_found' });
    const advertisedSize = Math.max(0, Number(attachment?.size) || 0);
    const maximum = Number(this.config.mailMaxAttachmentBytes || 5242880);
    if (advertisedSize > maximum) {
      throw new MailClientError('Attachment is too large to download safely', { statusCode: 413, code: 'attachment_too_large' });
    }
    const blobOps = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:blob'],
      methodCalls: [['Blob/get', {
        accountId: '$ACCOUNT_ID', ids: ['$BLOB_ID'], properties: ['data:asBase64', 'size'],
      }, 'b0']],
    };
    const outputLimit = Math.max(DEFAULT_OUTPUT_LIMIT, Math.ceil(maximum * 4 / 3) + 1048576);
    const blobResult = await this.request(username, { ops: blobOps, vars: { BLOB_ID: blobId }, outputLimit, signal });
    const blob = methodResponse(blobResult, 'Blob/get', 'b0')?.list?.[0];
    const encoded = typeof blob?.['data:asBase64'] === 'string' ? blob['data:asBase64'] : '';
    const data = Buffer.from(encoded, 'base64');
    if (!encoded || data.length > maximum || (advertisedSize && data.length !== advertisedSize)) {
      throw new MailClientError('Attachment data is invalid or exceeds the safety limit', { statusCode: 502, code: 'invalid_attachment_data' });
    }
    return {
      data,
      name: safeAttachmentFilename(attachment?.name, index),
      type: String(attachment?.type || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 255),
      size: data.length,
    };
  }
}
