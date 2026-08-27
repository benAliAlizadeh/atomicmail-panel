import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminAuth } from './auth.js';
import { generateUniqueUsernames, normalizePrefix } from './username-generator.js';
import { redactSecrets } from './utils.js';

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

function exportFilename(extension) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  return `atomicmail-mailboxes-${stamp}.${extension}`;
}

function serveStatic(res, filename, type) {
  const file = path.join(publicDir, filename);
  return text(res, 200, fs.readFileSync(file), type, { 'cache-control': 'no-cache' });
}

export function createServer({ store, worker, config }) {
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
        const usernames = generateUniqueUsernames(
          count,
          (username) => store.isUsernameTaken(username),
          { prefix, minLength: config.usernameMinLength, maxLength: config.usernameMaxLength },
        );
        const job = store.createJob({ count, prefix, usernames });
        return json(res, 201, job);
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

      if (req.method === 'GET' && pathname === '/api/mailboxes') {
        const limit = boundedInt(url.searchParams.get('limit'), 50, 1, 500);
        const offset = boundedInt(url.searchParams.get('offset'), 0, 0, 100000000);
        const search = String(url.searchParams.get('search') || '').slice(0, 100);
        return json(res, 200, {
          total: store.countMailboxes(search),
          items: store.listMailboxes(limit, offset, search),
        });
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        const limit = boundedInt(url.searchParams.get('limit'), 100, 1, 500);
        return json(res, 200, { items: store.recentAudit(limit) });
      }

      if (req.method === 'GET' && pathname === '/api/system/circuit') {
        return json(res, 200, worker.circuitState());
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
      if (status >= 500) store.audit('error', 'http.internal_error', redactSecrets(String(error?.stack || error)));
      return json(res, status, { error: status >= 500 ? 'Internal server error' : error.message });
    }
  });
}
