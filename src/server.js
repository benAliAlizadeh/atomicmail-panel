import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminAuth } from './auth.js';
import { generateUniqueUsernames, normalizePrefix } from './username-generator.js';
import { newId, redactSecrets } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function send(res, status, body, type, extraHeaders = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'content-type': type,
    'content-length': content.length,
    ...extraHeaders,
  });
  res.end(content);
}

function json(res, status, payload, extraHeaders = {}) {
  return send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', {
    'cache-control': 'no-store',
    ...extraHeaders,
  });
}

function text(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return send(res, status, body, type, extraHeaders);
}

async function readJson(req, maxBytes = 65536) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function routeMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let i = 0; i < pathParts.length; i += 1) {
    const expected = patternParts[i];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(pathParts[i]);
    else if (expected !== pathParts[i]) return null;
  }
  return params;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clientAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  if (req.aborted || res.destroyed) abort();
  return controller.signal;
}

function requestLooksCrossSite(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function csvCell(value) {
  let textValue = String(value ?? '');
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replaceAll('"', '""')}"`;
}

function mailboxesCsv(items) {
  const columns = ['email', 'username', 'status', 'created_at', 'job_id'];
  const rows = [columns.map(csvCell).join(',')];
  for (const item of items) rows.push(columns.map((column) => csvCell(item[column])).join(','));
  return `${rows.join('\r\n')}\r\n`;
}

function sensitiveMailboxesCsv(items) {
  const rows = [['Email', 'DestinationPassword'].map(csvCell).join(',')];
  for (const item of items) rows.push([item.email, item.destinationPassword].map(csvCell).join(','));
  return `${rows.join('\r\n')}\r\n`;
}

function contentDispositionFilename(filename) {
  const clean = path.basename(String(filename || 'attachment.bin'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\/]/g, '_')
    .trim()
    .slice(0, 180) || 'attachment.bin';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function assertDestinationPassword(value, config) {
  const password = String(value ?? '');
  if (!password) return '';
  const maximum = Number(config.destinationPasswordMaxBytes || 1024);
  if (Buffer.byteLength(password, 'utf8') > maximum) {
    throw Object.assign(new Error('Destination password is too large'), { statusCode: 413, expose: true });
  }
  return password;
}

function decodeBase64(value) {
  const encoded = String(value || '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw Object.assign(new Error('Attachment data is invalid'), { statusCode: 400, expose: true });
  }
  return Buffer.from(encoded, 'base64');
}

function parseAttachments(value, config) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error('attachments must be an array'), { statusCode: 400, expose: true });
  const maxCount = Number(config.mailMaxAttachmentCount || 5);
  const maxEach = Number(config.mailMaxAttachmentBytes || 5242880);
  const maxTotal = Number(config.mailMaxTotalAttachmentBytes || 10485760);
  if (value.length > maxCount) {
    throw Object.assign(new Error(`A maximum of ${maxCount} attachments is allowed`), { statusCode: 413, expose: true });
  }
  let total = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('Attachment metadata is invalid'), { statusCode: 400, expose: true });
    }
    const name = path.basename(String(item.name || `attachment-${index + 1}.bin`))
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .trim()
      .slice(0, 180) || `attachment-${index + 1}.bin`;
    const type = String(item.type || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 255);
    if (!/^[\w!#$&^_.+\-]+\/[\w!#$&^_.+\-]+(?:;[\x20-\x7e]+)?$/.test(type)) {
      throw Object.assign(new Error(`Attachment ${index + 1} has an invalid MIME type`), { statusCode: 400, expose: true });
    }
    const data = decodeBase64(item.data);
    if (data.length > maxEach) {
      throw Object.assign(new Error(`Attachment ${index + 1} exceeds the ${maxEach}-byte limit`), { statusCode: 413, expose: true });
    }
    total += data.length;
    if (total > maxTotal) {
      throw Object.assign(new Error(`Attachments exceed the ${maxTotal}-byte total limit`), { statusCode: 413, expose: true });
    }
    return { name, type, data };
  });
}

function composeRequestLimit(config) {
  const attachments = Number(config.mailMaxTotalAttachmentBytes || 10485760);
  const compose = Number(config.mailMaxComposeBytes || 204800);
  return Math.max(262144, Math.ceil(attachments * 4 / 3) + compose + 262144);
}

function mailErrorPayload(error, status) {
  const detail = redactSecrets(String(error?.message || '')).slice(0, 1000);
  if (status < 500 && !String(error?.code || '').startsWith('mail_') && error?.code !== 'jmap_method_error') {
    return { error: detail || 'Request failed', code: error?.code || undefined };
  }
  const summaries = {
    mail_timeout: 'The mail provider timed out',
    jmap_method_error: 'The mail provider rejected this operation',
    mailbox_unavailable: 'This mail folder is unavailable',
    attachment_not_found: 'Attachment was not found',
    attachment_too_large: 'Attachment exceeds the safety limit',
  };
  return {
    error: summaries[error?.code] || (status >= 500 ? 'Unable to complete the mail operation' : 'Mail operation failed'),
    code: error?.code || 'mail_provider_error',
    ...(detail ? { detail } : {}),
  };
}

function exportFilename(extension) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  return `atomicmail-mailboxes-${stamp}.${extension}`;
}

function serveStatic(res, filename, type) {
  const file = path.join(publicDir, filename);
  return text(res, 200, fs.readFileSync(file), type, { 'cache-control': 'no-cache' });
}

export function createServer({ store, worker, config, backupManager = null, vault = null, mailClient = null }) {
  const auth = new AdminAuth(config);

  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/api/auth/status') {
        return json(res, 200, auth.status(req));
      }

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        if (requestLooksCrossSite(req)) return json(res, 403, { error: 'Cross-site request rejected' });
        const body = await readJson(req, 8192);
        const ip = req.socket.remoteAddress || 'unknown';
        const result = auth.login({
          username: String(body.username || ''),
          password: String(body.password || ''),
          ip,
        });
        if (!result.ok && result.rateLimited) {
          const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
          store.audit('warn', 'auth.login_rate_limited', `Admin login rate limited for ${ip}`);
          return json(res, 429, { error: 'Too many login attempts. Try again later.', retryAfterSeconds: seconds }, { 'retry-after': String(seconds) });
        }
        if (!result.ok) {
          store.audit('warn', 'auth.login_failed', `Failed admin login from ${ip}`);
          return json(res, 401, { error: 'Invalid username or password' });
        }
        store.audit('info', 'auth.login_succeeded', `Admin login from ${ip}`);
        const headers = result.setCookie ? { 'set-cookie': result.setCookie } : {};
        return json(res, 200, {
          authenticated: true,
          authRequired: auth.enabled,
          username: result.session.username,
          csrf: result.session.csrf,
          expiresAt: result.session.expiresAt ? new Date(result.session.expiresAt).toISOString() : null,
        }, headers);
      }

      let session = null;
      if (pathname.startsWith('/api/')) {
        session = auth.getSession(req);
        if (auth.enabled && !session) return json(res, 401, { error: 'Authentication required' });
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
          if (requestLooksCrossSite(req)) return json(res, 403, { error: 'Cross-site request rejected' });
          if (!auth.verifyCsrf(req, session)) return json(res, 403, { error: 'Invalid CSRF token' });
        }
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        store.audit('info', 'auth.logout', 'Admin logged out');
        return json(res, 200, { authenticated: false }, { 'set-cookie': auth.logout(req) });
      }

      if (req.method === 'GET' && pathname === '/api/dashboard') {
        return json(res, 200, {
          ...store.getDashboardStats(),
          workerEnabled: config.workerEnabled,
          circuit: worker.circuitState(),
          limits: {
            maxBatchSize: config.maxBatchSize,
            usernameMinLength: config.usernameMinLength,
            usernameMaxLength: config.usernameMaxLength,
          },
          registration: {
            mailboxType: 'agent',
            domain: 'atomicmail.ai',
            authentication: 'api-key',
            passwordSupported: false,
            recoverySeedSupported: false,
            registerTimeoutMs: config.registerTimeoutMs,
            postSuccessDelayMs: config.postSuccessDelayMs,
          },
          mail: {
            commandTimeoutMs: Number(config.mailCommandTimeoutMs || 60000),
            autoRefreshSeconds: Number(config.mailAutoRefreshSeconds || 45),
            pageSize: Number(config.mailInboxLimit || 50),
            maxComposeBytes: Number(config.mailMaxComposeBytes || 204800),
            maxAttachmentCount: Number(config.mailMaxAttachmentCount || 5),
            maxAttachmentBytes: Number(config.mailMaxAttachmentBytes || 5242880),
            maxTotalAttachmentBytes: Number(config.mailMaxTotalAttachmentBytes || 10485760),
          },
        });
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        const limit = boundedInt(url.searchParams.get('limit'), 50, 1, 200);
        return json(res, 200, { jobs: store.listJobs(limit) });
      }

      const getJob = routeMatch(pathname, '/api/jobs/:id');
      if (req.method === 'GET' && getJob) {
        const job = store.getJob(getJob.id);
        return job ? json(res, 200, job) : json(res, 404, { error: 'Job not found' });
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        const circuit = worker.circuitState();
        if (circuit.open) {
          const message = circuit.permanent
            ? 'Registration is stopped by the permanent circuit breaker. Review and reset it before creating more work.'
            : 'Registration is temporarily paused by the circuit breaker. Wait for the cooldown before creating more work.';
          return json(res, 409, { error: message });
        }
        const body = await readJson(req);
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > config.maxBatchSize) {
          return json(res, 400, { error: `count must be an integer between 1 and ${config.maxBatchSize}` });
        }
        const prefix = normalizePrefix(body.prefix || '');
        const destinationPassword = assertDestinationPassword(body.destinationPassword, config);
        if (destinationPassword && !vault?.sealJobPassword) {
          return json(res, 503, { error: 'Encrypted destination-password vault is unavailable' });
        }
        const usernames = generateUniqueUsernames(
          count,
          (username) => store.isUsernameTaken(username),
          { prefix, minLength: config.usernameMinLength, maxLength: config.usernameMaxLength },
        );
        const id = newId('job');
        const destinationPasswordCiphertext = destinationPassword
          ? vault.sealJobPassword(destinationPassword, id)
          : null;
        const job = store.createJob({ id, count, prefix, usernames, destinationPasswordCiphertext });
        if (destinationPasswordCiphertext) backupManager?.requestBackup?.('job-password-created');
        return json(res, 201, job);
      }

      const revealJobPassword = routeMatch(pathname, '/api/jobs/:id/destination-password');
      if (req.method === 'POST' && revealJobPassword) {
        if (!vault?.openJobPassword) return json(res, 503, { error: 'Encrypted destination-password vault is unavailable' });
        const record = store.getJobPasswordCiphertext(revealJobPassword.id);
        if (!record) return json(res, 404, { error: 'Job not found' });
        if (!record.destination_password_ciphertext) return json(res, 404, { error: 'Destination password is not configured for this job' });
        const password = vault.openJobPassword(record.destination_password_ciphertext, record.id);
        store.audit('info', 'job.destination_password_revealed', 'Destination password revealed by operator', record.id);
        return json(res, 200, { password });
      }

      for (const action of ['pause', 'resume', 'cancel']) {
        const match = routeMatch(pathname, `/api/jobs/:id/${action}`);
        if (req.method === 'POST' && match) {
          const job = store.getJob(match.id);
          if (!job) return json(res, 404, { error: 'Job not found' });
          if (['completed', 'cancelled'].includes(job.status)) return json(res, 409, { error: `Job is already ${job.status}` });

          if (action === 'pause') store.setJobStatus(match.id, 'paused');
          if (action === 'resume') {
            if (worker.circuitState().permanent) return json(res, 409, { error: 'Permanent circuit is open. Review and reset it first.' });
            store.setJobStatus(match.id, 'running');
          }
          if (action === 'cancel') {
            store.setJobStatus(match.id, 'cancelled');
            store.cancelPendingItems(match.id);
          }
          store.audit('info', `job.${action}`, `Job ${action} requested`, match.id);
          return json(res, 200, store.getJob(match.id));
        }
      }

      if (req.method === 'GET' && pathname === '/api/mailboxes/export') {
        const search = String(url.searchParams.get('search') || '').slice(0, 100);
        const format = String(url.searchParams.get('format') || 'csv').toLowerCase();
        if (!['csv', 'json'].includes(format)) return json(res, 400, { error: 'format must be csv or json' });
        const total = store.countMailboxes(search);
        if (total > config.exportMaxRows) {
          return json(res, 409, { error: `Export is limited to ${config.exportMaxRows} rows. Narrow the search first.` });
        }
        const items = store.exportMailboxes(search, config.exportMaxRows);
        if (format === 'json') {
          return text(res, 200, JSON.stringify({ generatedAt: new Date().toISOString(), total, items }, null, 2), 'application/json; charset=utf-8', {
            'cache-control': 'no-store',
            'content-disposition': `attachment; filename="${exportFilename('json')}"`,
          });
        }
        return text(res, 200, mailboxesCsv(items), 'text/csv; charset=utf-8', {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${exportFilename('csv')}"`,
        });
      }

      if (req.method === 'POST' && pathname === '/api/mailboxes/export-sensitive') {
        if (!vault?.openJobPassword) return json(res, 503, { error: 'Encrypted destination-password vault is unavailable' });
        const body = await readJson(req, 8192);
        if (body.confirm !== 'EXPORT') return json(res, 400, { error: 'Sensitive export requires confirm="EXPORT"' });
        const search = String(body.search || '').slice(0, 100);
        const total = store.countMailboxes(search);
        if (total > config.exportMaxRows) {
          return json(res, 409, { error: `Export is limited to ${config.exportMaxRows} rows. Narrow the search first.` });
        }
        const items = store.exportMailboxes(search, config.exportMaxRows).map((mailbox) => {
          const record = store.getMailboxPasswordCiphertext(mailbox.id);
          return {
            email: mailbox.email,
            destinationPassword: record?.destination_password_ciphertext
              ? vault.openJobPassword(record.destination_password_ciphertext, record.job_id)
              : '',
          };
        });
        store.audit('warn', 'mailboxes.sensitive_export', `Explicit destination-password export created for ${items.length} mailbox(es)`);
        return text(res, 200, sensitiveMailboxesCsv(items), 'text/csv; charset=utf-8', {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${exportFilename('csv').replace('.csv', '-destination-passwords.csv')}"`,
        });
      }

      if (req.method === 'GET' && pathname === '/api/mailboxes') {
        const limit = boundedInt(url.searchParams.get('limit'), 50, 1, 500);
        const offset = boundedInt(url.searchParams.get('offset'), 0, 0, 100000000);
        const search = String(url.searchParams.get('search') || '').slice(0, 100);
        return json(res, 200, {
          total: store.countMailboxes(search),
          items: store.listMailboxes(limit, offset, search),
        });
      }

      const revealMailboxPassword = routeMatch(pathname, '/api/mailboxes/:id/destination-password');
      if (req.method === 'POST' && revealMailboxPassword) {
        if (!vault?.openJobPassword) return json(res, 503, { error: 'Encrypted destination-password vault is unavailable' });
        const record = store.getMailboxPasswordCiphertext(revealMailboxPassword.id);
        if (!record) return json(res, 404, { error: 'Mailbox not found' });
        if (!record.destination_password_ciphertext) return json(res, 404, { error: 'Destination password is not configured for this mailbox' });
        const password = vault.openJobPassword(record.destination_password_ciphertext, record.job_id);
        store.audit('info', 'mailbox.destination_password_revealed', `Destination password revealed for ${record.email}`, record.job_id);
        return json(res, 200, { password });
      }

      const inboxMatch = routeMatch(pathname, '/api/mailboxes/:id/inbox');
      if (req.method === 'GET' && inboxMatch) {
        if (!mailClient) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(inboxMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const limit = boundedInt(url.searchParams.get('limit'), config.mailInboxLimit || 50, 1, 100);
        const inbox = await mailClient.listInbox(mailbox.username, { limit, signal: clientAbortSignal(req, res) });
        return json(res, 200, { mailbox, ...inbox });
      }

      const mailListMatch = routeMatch(pathname, '/api/mailboxes/:id/mail');
      if (req.method === 'GET' && mailListMatch) {
        if (!mailClient?.listMailbox) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(mailListMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const limit = boundedInt(url.searchParams.get('limit'), config.mailInboxLimit || 50, 1, 100);
        const position = boundedInt(url.searchParams.get('position'), 0, 0, 100000000);
        const folder = String(url.searchParams.get('folder') || 'inbox').toLowerCase();
        const field = String(url.searchParams.get('field') || 'subject').toLowerCase();
        const search = String(url.searchParams.get('search') || '');
        if (Buffer.byteLength(search, 'utf8') > Number(config.mailMaxSearchBytes || 256)) {
          return json(res, 413, { error: 'Search query is too large' });
        }
        const mail = await mailClient.listMailbox(mailbox.username, {
          folder, limit, position, search, field, signal: clientAbortSignal(req, res),
        });
        return json(res, 200, { mailbox, ...mail });
      }

      const messageMatch = routeMatch(pathname, '/api/mailboxes/:id/messages/:messageId');
      if (req.method === 'GET' && messageMatch) {
        if (!mailClient) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(messageMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const message = await mailClient.getMessage(
          mailbox.username,
          messageMatch.messageId,
          { signal: clientAbortSignal(req, res) },
        );
        return json(res, 200, { mailbox, message });
      }

      const attachmentMatch = routeMatch(pathname, '/api/mailboxes/:id/messages/:messageId/attachments/:attachmentId');
      if (req.method === 'GET' && attachmentMatch) {
        if (!mailClient?.downloadAttachment) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(attachmentMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const attachment = await mailClient.downloadAttachment(
          mailbox.username,
          attachmentMatch.messageId,
          attachmentMatch.attachmentId,
          { signal: clientAbortSignal(req, res) },
        );
        return send(res, 200, attachment.data, attachment.type || 'application/octet-stream', {
          'cache-control': 'no-store',
          'content-disposition': contentDispositionFilename(attachment.name),
          'content-security-policy': "default-src 'none'; sandbox",
        });
      }

      const actionMatch = routeMatch(pathname, '/api/mailboxes/:id/messages/:messageId/actions');
      if (req.method === 'POST' && actionMatch) {
        if (!mailClient?.updateMessage) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(actionMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const body = await readJson(req, 4096);
        const action = String(body.action || '');
        const result = await mailClient.updateMessage(mailbox.username, actionMatch.messageId, action);
        store.audit('info', `mail.${result.action}`, `Mail action ${result.action} completed for ${mailbox.email}`);
        return json(res, 200, result);
      }

      const sendMatch = routeMatch(pathname, '/api/mailboxes/:id/send');
      if (req.method === 'POST' && sendMatch) {
        if (!mailClient) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(sendMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const body = await readJson(req, composeRequestLimit(config));
        const attachments = parseAttachments(body.attachments, config);
        const result = await mailClient.send(mailbox.username, {
          to: body.to,
          subject: body.subject,
          body: body.body,
          attachments,
        });
        store.audit('info', 'mail.sent', `Message sent from ${mailbox.email}`);
        return json(res, 201, result);
      }

      const replyMatch = routeMatch(pathname, '/api/mailboxes/:id/messages/:messageId/reply');
      if (req.method === 'POST' && replyMatch) {
        if (!mailClient) return json(res, 503, { error: 'Mail client is unavailable' });
        const mailbox = store.getMailbox(replyMatch.id);
        if (!mailbox) return json(res, 404, { error: 'Mailbox not found' });
        if (mailbox.status !== 'active') return json(res, 409, { error: 'Mailbox is not active' });
        const body = await readJson(req, composeRequestLimit(config));
        const attachments = parseAttachments(body.attachments, config);
        const result = await mailClient.reply(mailbox.username, replyMatch.messageId, { body: body.body, attachments });
        store.audit('info', 'mail.replied', `Reply sent from ${mailbox.email}`);
        return json(res, 201, result);
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        const limit = boundedInt(url.searchParams.get('limit'), 100, 1, 500);
        return json(res, 200, { items: store.recentAudit(limit) });
      }

      if (req.method === 'GET' && pathname === '/api/system/circuit') {
        return json(res, 200, worker.circuitState());
      }

      if (req.method === 'GET' && pathname === '/api/system/data-safety') {
        return json(res, 200, {
          vault: vault?.status?.() || null,
          backups: backupManager?.status?.() || null,
          restore: {
            onlineSupported: false,
            command: 'npm.cmd run backup:restore -- <backup-file>',
            note: 'Stop the panel before restore. Keep the encryption key separately from data/backups.',
          },
        });
      }

      if (req.method === 'POST' && pathname === '/api/system/backups') {
        if (!backupManager) return json(res, 503, { error: 'Backup manager is unavailable' });
        const result = await backupManager.createBackup('manual');
        store.audit('info', 'backup.created', `Encrypted backup created: ${result.name}`);
        return json(res, 201, result);
      }

      if (req.method === 'POST' && pathname === '/api/system/backups/verify') {
        if (!backupManager) return json(res, 503, { error: 'Backup manager is unavailable' });
        const body = await readJson(req, 4096);
        const name = body.name || backupManager.latestBackup()?.name;
        if (!name) return json(res, 404, { error: 'No backup exists to verify' });
        const result = backupManager.verifyBackup(name);
        store.audit('info', 'backup.verified', `Encrypted backup verified: ${result.name}`);
        return json(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/api/system/circuit/reset') {
        const circuit = worker.circuitState();
        const body = await readJson(req, 4096);
        if (circuit.permanent && body.confirm !== 'RESET') {
          return json(res, 400, { error: 'Permanent circuit reset requires confirm="RESET" after manual review.' });
        }
        worker.resetCircuit();
        return json(res, 200, worker.circuitState());
      }

      if (req.method === 'GET' && pathname === '/') {
        return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && pathname === '/styles.css') {
        return serveStatic(res, 'styles.css', 'text/css; charset=utf-8');
      }
      if (req.method === 'GET' && pathname === '/app.js') {
        return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
      }

      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (error?.name === 'MailClientError') {
        if (error.code === 'mail_cancelled') {
          if (res.destroyed || res.writableEnded) return;
          return json(res, 499, { error: 'Mail request was cancelled', code: 'mail_cancelled' });
        }
        store.audit('error', 'mail.operation_failed', `Mail operation failed (${String(error.code || 'mail_provider_error').slice(0, 80)}, HTTP ${status})`);
        return json(res, status, mailErrorPayload(error, status));
      }
      if (status >= 500) store.audit('error', 'http.internal_error', redactSecrets(String(error?.stack || error)));
      const safeMessage = error?.expose === true || status < 500
        ? redactSecrets(String(error?.message || 'Request failed')).slice(0, 1000)
        : 'Internal server error';
      return json(res, status, { error: safeMessage });
    }
  });
}
