import { spawn } from 'node:child_process';
import { resolveProviderInvocation } from './provider.js';
import { redactSecrets } from './utils.js';

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class MailClientError extends Error {
  constructor(message, { statusCode = 502, code = 'mail_provider_error' } = {}) {
    super(message);
    this.name = 'MailClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

function runCliProcess(command, args, { env, timeoutMs, outputLimit = DEFAULT_OUTPUT_LIMIT } = {}) {
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
    let forceKillTimer = null;

    const append = (current, chunk) => {
      if (current.length >= outputLimit) return current;
      return (current + chunk.toString('utf8')).slice(0, outputLimit);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 2000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

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
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function safeJson(text) {
  try { return JSON.parse(String(text || '').trim()); } catch { return null; }
}

function methodResponse(body, methodName) {
  const responses = Array.isArray(body?.methodResponses) ? body.methodResponses : [];
  const row = responses.find((entry) => Array.isArray(entry) && entry[0] === methodName);
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

function normalizedMessage(row) {
  const bodyValues = row?.bodyValues || {};
  const textBody = bodyPartValues(row?.textBody, bodyValues);
  const htmlBody = bodyPartValues(row?.htmlBody, bodyValues);
  const fallbackBody = textBody || htmlToSafeText(htmlBody) || String(row?.preview || '');
  const truncated = Object.values(bodyValues).some((value) => Boolean(value?.isTruncated));
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
    hasAttachment: Boolean(row?.hasAttachment) || (Array.isArray(row?.attachments) && row.attachments.length > 0),
    attachmentCount: Array.isArray(row?.attachments) ? row.attachments.length : 0,
    links: extractSafeLinks(`${fallbackBody}\n${textBody}`, htmlBody),
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
    subject: String(row?.subject || '(no subject)'),
    receivedAt: row?.receivedAt || null,
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

export class AtomicMailJmapClient {
  constructor(config, vault, { runner = runCliProcess } = {}) {
    this.config = config;
    this.vault = vault;
    this.runner = runner;
    this.queues = new Map();
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

  async request(username, { ops = null, opsFile = null, vars = null }) {
    return this.enqueue(username, async () => {
      const runtimeDir = this.vault.materialize(username);
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

      let result;
      try {
        const invocation = resolveProviderInvocation(this.config.atomicCliCommand, args);
        result = await this.runner(invocation.command, invocation.args, {
          env,
          timeoutMs: this.config.mailCommandTimeoutMs,
        });
      } catch (error) {
        this.vault.discardRuntime(runtimeDir);
        throw new MailClientError(`Could not start Atomic Mail mail command: ${redactSecrets(error?.message || String(error))}`);
      }

      if (result.timedOut) {
        this.vault.discardRuntime(runtimeDir);
        throw new MailClientError('Atomic Mail mail request timed out', { statusCode: 504, code: 'mail_timeout' });
      }
      if (result.code !== 0) {
        this.vault.discardRuntime(runtimeDir);
        const detail = redactSecrets(String(result.stderr || result.stdout || `CLI exited with code ${result.code}`)).trim();
        throw new MailClientError(`Atomic Mail mail request failed${detail ? `: ${detail.slice(0, 700)}` : ''}`);
      }

      const body = safeJson(result.stdout);
      if (!body || typeof body !== 'object') {
        this.vault.discardRuntime(runtimeDir);
        throw new MailClientError('Atomic Mail returned an invalid JMAP response');
      }

      try {
        const sealed = this.vault.commitRuntime(username, runtimeDir);
        if (!sealed) throw new Error('runtime credentials were not complete');
      } catch (error) {
        this.vault.discardRuntime(runtimeDir);
        throw new MailClientError(`Mail request succeeded but refreshed credentials could not be encrypted: ${redactSecrets(error?.message || String(error))}`);
      }

      const methodError = firstMethodError(body);
      if (methodError) throw new MailClientError(`Atomic Mail rejected the mail operation: ${redactSecrets(methodError).slice(0, 500)}`, { statusCode: 422, code: 'jmap_method_error' });
      return body;
    });
  }

  async listInbox(username, { limit = 50 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const ops = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', {
          accountId: '$ACCOUNT_ID',
          filter: { inMailbox: '$INBOX_MAILBOX_ID' },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: safeLimit,
        }, 'q0'],
        ['Email/get', {
          accountId: '$ACCOUNT_ID',
          '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'threadId', 'receivedAt', 'from', 'to', 'subject', 'preview', 'keywords', 'hasAttachment'],
        }, 'g0'],
      ],
    };
    const result = await this.request(username, { ops });
    const query = methodResponse(result, 'Email/query') || {};
    const get = methodResponse(result, 'Email/get') || {};
    return {
      total: Number(query.total ?? query.ids?.length ?? 0),
      state: String(query.queryState || get.state || ''),
      items: Array.isArray(get.list) ? get.list.map(normalizeListMessage) : [],
    };
  }

  async getMessage(username, messageId) {
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
    const result = await this.request(username, { ops, vars: { MAIL_ID: id } });
    const payload = methodResponse(result, 'Email/get') || {};
    const row = Array.isArray(payload.list) ? payload.list[0] : null;
    if (!row) throw new MailClientError('Email message was not found', { statusCode: 404, code: 'message_not_found' });
    return normalizedMessage(row);
  }

  async send(username, { to, subject, body }) {
    const vars = {
      TO: assertEmail(to),
      SUBJECT: assertText(subject, 'Subject', { max: this.config.mailMaxSubjectBytes, required: false }),
      BODY: assertText(body, 'Message body', { max: this.config.mailMaxComposeBytes }),
    };
    const result = await this.request(username, { opsFile: 'send_mail.json', vars });
    const emailSet = methodResponse(result, 'Email/set') || {};
    const submission = methodResponse(result, 'EmailSubmission/set') || {};
    return {
      emailId: emailSet.created?.d1?.id || null,
      submissionId: submission.created?.s1?.id || null,
      to: vars.TO,
    };
  }

  async reply(username, messageId, { body }) {
    const vars = {
      MAIL_ID: assertText(messageId, 'messageId', { max: 1024 }),
      BODY: assertText(body, 'Reply body', { max: this.config.mailMaxComposeBytes }),
    };
    const result = await this.request(username, { opsFile: 'reply.json', vars });
    const emailSet = methodResponse(result, 'Email/set') || {};
    const submission = methodResponse(result, 'EmailSubmission/set') || {};
    return {
      emailId: emailSet.created?.d1?.id || null,
      submissionId: submission.created?.s1?.id || null,
    };
  }
}
