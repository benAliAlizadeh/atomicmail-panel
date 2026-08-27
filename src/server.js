import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateUniqueUsernames, normalizePrefix } from './username-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
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

export function createServer({ store, worker, config }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, {
          ok: true,
          workerEnabled: config.workerEnabled,
          circuit: worker.circuitState(),
          mailboxes: store.countMailboxes(),
        });
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        return json(res, 200, { jobs: store.listJobs(limit) });
      }

      const getJob = routeMatch(pathname, '/api/jobs/:id');
      if (req.method === 'GET' && getJob) {
        const job = store.getJob(getJob.id);
        return job ? json(res, 200, job) : json(res, 404, { error: 'Job not found' });
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        if (worker.circuitState().permanent) {
          return json(res, 409, { error: 'Registration is stopped by the permanent circuit breaker. Review and reset it before creating more work.' });
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

      if (req.method === 'GET' && pathname === '/api/mailboxes') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        return json(res, 200, { total: store.countMailboxes(), items: store.listMailboxes(limit, offset) });
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        return json(res, 200, { items: store.recentAudit(limit) });
      }

      if (req.method === 'GET' && pathname === '/api/system/circuit') {
        return json(res, 200, worker.circuitState());
      }

      if (req.method === 'POST' && pathname === '/api/system/circuit/reset') {
        worker.resetCircuit();
        return json(res, 200, worker.circuitState());
      }

      if (req.method === 'GET' && pathname === '/') {
        const file = path.join(publicDir, 'index.html');
        return text(res, 200, fs.readFileSync(file, 'utf8'), 'text/html; charset=utf-8');
      }

      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      return json(res, status, { error: status >= 500 ? 'Internal server error' : error.message });
    }
  });
}
