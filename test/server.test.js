import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { createServer } from '../src/server.js';
import { CredentialVault } from '../src/credential-vault.js';

function makeConfig(root, adminPassword = '') {
  return {
    workerEnabled: false,
    maxBatchSize: 20,
    usernameMinLength: 10,
    usernameMaxLength: 14,
    exportMaxRows: 1000,
    registerTimeoutMs: 180000,
    postSuccessDelayMs: 5000,
    adminUsername: 'admin',
    adminPassword,
    adminSessionTtlMs: 3600000,
    adminLoginMaxAttempts: 5,
    adminLoginWindowMs: 60000,
    adminCookieSecure: false,
    credentialsRoot: path.join(root, 'credentials'),
  };
}

async function withServer(adminPassword, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-server-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = {
    circuit: { open: false, permanent: false, until: null, reason: null },
    circuitState() { return this.circuit; },
    resetCircuit() { this.circuit = { open: false, permanent: false, until: null, reason: null }; },
  };
  const server = createServer({ store, worker, config: makeConfig(root, adminPassword) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ base, store, root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  return (response.headers.get('set-cookie') || '').split(';', 1)[0];
}

test('admin auth protects APIs and requires CSRF for mutations', async () => {
  await withServer('correct-horse-battery-staple', async ({ base }) => {
    const denied = await fetch(`${base}/api/dashboard`);
    assert.equal(denied.status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery-staple' }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.ok(loginBody.csrf);
    const cookie = cookieFrom(login);
    assert.match(cookie, /^atomicmail_admin=/);

    const noCsrf = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 1 }),
    });
    assert.equal(noCsrf.status, 403);

    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-atomicmail-csrf': loginBody.csrf },
      body: JSON.stringify({ count: 1 }),
    });
    assert.equal(created.status, 201);
  });
});

test('open circuit blocks creation of additional batches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-server-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = {
    circuitState() { return { open: true, permanent: false, until: new Date(Date.now() + 60000).toISOString(), reason: 'cooldown' }; },
    resetCircuit() {},
  };
  const server = createServer({ store, worker, config: makeConfig(root, '') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 1 }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /temporarily paused/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mailbox APIs and exports never expose credential paths', async () => {
  await withServer('', async ({ base, store, root }) => {
    const job = store.createJob({ count: 1, prefix: '', usernames: ['alpha11111'] });
    const item = store.markItemRunning(job.items[0].id);
    store.markItemSucceeded(item.id, {
      username: item.username,
      email: `${item.username}@atomicmail.ai`,
      inboxId: `${item.username}@atomicmail.ai`,
      credentialsPath: path.join(root, 'credentials', item.username, 'credentials.json'),
    });

    const response = await fetch(`${base}/api/mailboxes`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].email, 'alpha11111@atomicmail.ai');
    assert.equal(Object.hasOwn(body.items[0], 'credentials_path'), false);
    assert.equal(Object.hasOwn(body.items[0], 'inbox_id'), false);

    const csv = await fetch(`${base}/api/mailboxes/export?format=csv`);
    assert.equal(csv.status, 200);
    const csvBody = await csv.text();
    assert.match(csvBody, /alpha11111@atomicmail\.ai/);
    assert.doesNotMatch(csvBody, /credentials/i);
    assert.doesNotMatch(csvBody, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('health is minimal and browser security headers are present', async () => {
  await withServer('', async ({ base }) => {
    const response = await fetch(`${base}/health`);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  });
});


test('dashboard describes agent credential model and timing guards', async () => {
  await withServer('', async ({ base }) => {
    const response = await fetch(`${base}/api/dashboard`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.registration, {
      mailboxType: 'agent',
      domain: 'atomicmail.ai',
      authentication: 'api-key',
      passwordSupported: false,
      recoverySeedSupported: false,
      registerTimeoutMs: 180000,
      postSuccessDelayMs: 5000,
    });
    assert.equal(body.mail.commandTimeoutMs, 60000);
  });
});

test('data-safety API exposes status without encryption key material and can verify backups', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-safety-api-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = {
    circuitState() { return { open: false, permanent: false, until: null, reason: null }; },
    resetCircuit() {},
  };
  const vault = {
    status() {
      return {
        encryption: 'AES-256-GCM', encryptedCredentialFiles: 1, plaintextCredentialFiles: 0,
        keySource: 'external-key-file', keyFingerprint: '0123456789abcdef', portable: true,
      };
    },
  };
  const backupManager = {
    status() { return { enabled: true, intervalMinutes: 360, retention: 14, latest: { name: 'safe.ambak' }, backupCount: 1 }; },
    latestBackup() { return { name: 'safe.ambak' }; },
    async createBackup() { return { name: 'safe.ambak', verified: true }; },
    verifyBackup() { return { name: 'safe.ambak', verified: true }; },
  };
  const server = createServer({ store, worker, config: makeConfig(root, ''), vault, backupManager });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const statusResponse = await fetch(`${base}/api/system/data-safety`);
    assert.equal(statusResponse.status, 200);
    const raw = await statusResponse.text();
    assert.match(raw, /0123456789abcdef/);
    assert.doesNotMatch(raw, /data\.key|DATA_ENCRYPTION_KEY|apiKey/i);

    const created = await fetch(`${base}/api/system/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).verified, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('webmail APIs expose inbox/read/send/reply without leaking credentials or message bodies into audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-webmail-api-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = {
    circuitState() { return { open: false, permanent: false, until: null, reason: null }; },
    resetCircuit() {},
  };
  const calls = [];
  const mailClient = {
    async listInbox(username, { limit }) {
      calls.push({ kind: 'inbox', username, limit });
      return {
        total: 1,
        state: 'state-1',
        items: [{
          id: 'm1', threadId: 't1', from: [{ email: 'sender@example.com' }], fromText: 'sender@example.com',
          to: [{ email: `${username}@atomicmail.ai` }], subject: 'Verify', receivedAt: '2026-08-27T10:00:00Z',
          preview: 'Code 123456', unread: true, hasAttachment: false,
        }],
      };
    },
    async getMessage(username, messageId) {
      calls.push({ kind: 'read', username, messageId });
      return {
        id: messageId, threadId: 't1', from: [{ email: 'sender@example.com' }], fromText: 'sender@example.com',
        to: [{ email: `${username}@atomicmail.ai` }], toText: `${username}@atomicmail.ai`, cc: [], ccText: '',
        subject: 'Verify', receivedAt: '2026-08-27T10:00:00Z', body: 'Use code 123456', bodyTruncated: false,
        links: ['https://example.com/verify'], unread: true, hasAttachment: false, attachmentCount: 0,
      };
    },
    async send(username, input) {
      calls.push({ kind: 'send', username, input });
      return { emailId: 'sent-1', submissionId: 'sub-1', to: input.to };
    },
    async reply(username, messageId, input) {
      calls.push({ kind: 'reply', username, messageId, input });
      return { emailId: 'reply-1', submissionId: 'sub-2' };
    },
  };

  const job = store.createJob({ count: 1, prefix: '', usernames: ['webmail1111'] });
  const item = store.markItemRunning(job.items[0].id);
  const mailboxId = store.markItemSucceeded(item.id, {
    username: item.username,
    email: `${item.username}@atomicmail.ai`,
    inboxId: item.username,
    credentialsPath: path.join(root, 'credentials', item.username, 'credentials.json.enc'),
  });

  const server = createServer({ store, worker, config: makeConfig(root, ''), mailClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const inboxResponse = await fetch(`${base}/api/mailboxes/${encodeURIComponent(mailboxId)}/inbox?limit=25`);
    assert.equal(inboxResponse.status, 200);
    const inboxRaw = await inboxResponse.text();
    assert.doesNotMatch(inboxRaw, /apiKey|credentials_path|credentials\.json|secret/i);
    assert.doesNotMatch(inboxRaw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const inbox = JSON.parse(inboxRaw);
    assert.equal(inbox.mailbox.email, 'webmail1111@atomicmail.ai');
    assert.equal(inbox.items[0].subject, 'Verify');

    const messageResponse = await fetch(`${base}/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/m1`);
    assert.equal(messageResponse.status, 200);
    const message = await messageResponse.json();
    assert.equal(message.message.body, 'Use code 123456');
    assert.deepEqual(message.message.links, ['https://example.com/verify']);

    const sendResponse = await fetch(`${base}/api/mailboxes/${encodeURIComponent(mailboxId)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'person@example.com', subject: 'Hello', body: 'private sent body 98765' }),
    });
    assert.equal(sendResponse.status, 201);
    assert.equal((await sendResponse.json()).submissionId, 'sub-1');

    const replyResponse = await fetch(`${base}/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/m1/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'private reply body 54321' }),
    });
    assert.equal(replyResponse.status, 201);
    assert.equal((await replyResponse.json()).submissionId, 'sub-2');

    assert.deepEqual(calls.map((call) => call.kind), ['inbox', 'read', 'send', 'reply']);
    assert.equal(calls[0].limit, 25);

    const auditResponse = await fetch(`${base}/api/audit?limit=50`);
    const auditRaw = await auditResponse.text();
    assert.match(auditRaw, /mail\.sent/);
    assert.match(auditRaw, /mail\.replied/);
    assert.doesNotMatch(auditRaw, /private sent body 98765|private reply body 54321/);
    assert.doesNotMatch(auditRaw, /credentials\.json|apiKey/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('per-job destination passwords are encrypted, CSRF-protected, explicitly exported, and absent from normal APIs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-password-api-'));
  const config = {
    ...makeConfig(root, 'correct-horse-battery-staple'),
    dataDir: path.join(root, 'data'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
    backupDir: path.join(root, 'backups'),
    destinationPasswordMaxBytes: 1024,
  };
  config.credentialsRoot = path.join(config.dataDir, 'credentials');
  const vault = new CredentialVault(config);
  vault.initialize();
  const store = new Store(path.join(config.dataDir, 'db.sqlite'));
  const worker = {
    circuitState() { return { open: false, permanent: false, until: null, reason: null }; },
    resetCircuit() {},
  };
  const server = createServer({ store, worker, config, vault });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const password = 'destination-only-secret-774411';
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery-staple' }),
    });
    const auth = await login.json();
    const cookie = cookieFrom(login);
    const headers = { cookie, 'content-type': 'application/json', 'x-atomicmail-csrf': auth.csrf };
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers,
      body: JSON.stringify({ count: 1, destinationPassword: password }),
    });
    assert.equal(created.status, 201);
    const rawCreated = await created.text();
    assert.doesNotMatch(rawCreated, new RegExp(password));
    assert.doesNotMatch(rawCreated, /ciphertext/i);
    const job = JSON.parse(rawCreated);
    assert.equal(job.has_destination_password, 1);

    const encrypted = store.db.prepare('SELECT destination_password_ciphertext FROM jobs WHERE id=?').get(job.id).destination_password_ciphertext;
    assert.ok(encrypted);
    assert.doesNotMatch(encrypted, new RegExp(password));

    const noCsrf = await fetch(`${base}/api/jobs/${job.id}/destination-password`, { method: 'POST', headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const reveal = await fetch(`${base}/api/jobs/${job.id}/destination-password`, { method: 'POST', headers, body: '{}' });
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json()).password, password);

    const running = store.markItemRunning(job.items[0].id);
    const mailboxId = store.markItemSucceeded(running.id, {
      username: running.username,
      email: `${running.username}@atomicmail.ai`,
      inboxId: running.username,
      credentialsPath: path.join(config.credentialsRoot, running.username, 'credentials.json.enc'),
    });
    const mailboxes = await (await fetch(`${base}/api/mailboxes`, { headers: { cookie } })).json();
    assert.equal(mailboxes.items[0].has_destination_password, 1);
    assert.doesNotMatch(JSON.stringify(mailboxes), new RegExp(password));

    const normalExport = await (await fetch(`${base}/api/mailboxes/export?format=csv`, { headers: { cookie } })).text();
    assert.doesNotMatch(normalExport, new RegExp(password));
    const mailboxReveal = await fetch(`${base}/api/mailboxes/${mailboxId}/destination-password`, { method: 'POST', headers, body: '{}' });
    assert.equal((await mailboxReveal.json()).password, password);

    const sensitive = await fetch(`${base}/api/mailboxes/export-sensitive`, {
      method: 'POST', headers, body: JSON.stringify({ confirm: 'EXPORT' }),
    });
    assert.equal(sensitive.status, 200);
    assert.match(await sensitive.text(), new RegExp(password));

    const audit = JSON.stringify(store.recentAudit(100));
    assert.doesNotMatch(audit, new RegExp(password));
    assert.doesNotMatch(audit, /destination_password_ciphertext/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('advanced mail API supports Sent/search/pagination/actions/attachments with resource guards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-advanced-mail-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = {
    circuitState() { return { open: false, permanent: false, until: null, reason: null }; },
    resetCircuit() {},
  };
  const calls = [];
  const mailClient = {
    async listMailbox(username, options) {
      calls.push({ kind: 'list', username, options });
      return { folder: options.folder, position: options.position, limit: options.limit, total: 41, unreadTotal: 2, state: 's1', syncedAt: '2026-08-27T12:00:00Z', items: [] };
    },
    async updateMessage(username, messageId, action) {
      calls.push({ kind: 'action', username, messageId, action });
      return { id: messageId, action, updated: true };
    },
    async downloadAttachment(username, messageId, attachmentId) {
      calls.push({ kind: 'download', username, messageId, attachmentId });
      return { data: Buffer.from('PDF'), name: '../report.pdf', type: 'application/pdf', size: 3 };
    },
    async send(username, input) {
      calls.push({ kind: 'send', username, input });
      return { emailId: 'e1', submissionId: 's1', to: input.to };
    },
  };
  const config = {
    ...makeConfig(root, ''),
    mailInboxLimit: 25,
    mailMaxSearchBytes: 64,
    mailMaxComposeBytes: 10000,
    mailMaxAttachmentCount: 2,
    mailMaxAttachmentBytes: 1024,
    mailMaxTotalAttachmentBytes: 1536,
  };
  const job = store.createJob({ count: 1, prefix: '', usernames: ['advanced111'] });
  const item = store.markItemRunning(job.items[0].id);
  const mailboxId = store.markItemSucceeded(item.id, {
    username: item.username, email: `${item.username}@atomicmail.ai`, inboxId: item.username,
    credentialsPath: path.join(root, 'credentials', item.username, 'credentials.json.enc'),
  });
  const server = createServer({ store, worker, config, mailClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await fetch(`${base}/api/mailboxes/${mailboxId}/mail?folder=sent&limit=25&position=25&field=to&search=person%40example.com`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).total, 41);
    const { signal, ...listOptions } = calls[0].options;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(listOptions, { folder: 'sent', limit: 25, position: 25, search: 'person@example.com', field: 'to' });

    const action = await fetch(`${base}/api/mailboxes/${mailboxId}/messages/m1/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'trash' }),
    });
    assert.equal(action.status, 200);

    const download = await fetch(`${base}/api/mailboxes/${mailboxId}/messages/m1/attachments/0`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'PDF');
    assert.match(download.headers.get('content-disposition') || '', /attachment; filename="report\.pdf"/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

    const send = await fetch(`${base}/api/mailboxes/${mailboxId}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'person@example.com', subject: 'File', body: 'private body',
        attachments: [{ name: '../safe.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }],
      }),
    });
    assert.equal(send.status, 201);
    const sendCall = calls.find((entry) => entry.kind === 'send');
    assert.equal(sendCall.input.attachments[0].name, 'safe.txt');
    assert.equal(sendCall.input.attachments[0].data.toString('utf8'), 'hello');

    const oversized = await fetch(`${base}/api/mailboxes/${mailboxId}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'person@example.com', subject: 'Too big', body: 'body',
        attachments: [{ name: 'large.bin', type: 'application/octet-stream', data: Buffer.alloc(1025).toString('base64') }],
      }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mail provider failures return redacted details and never persist them in audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-mail-error-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = { circuitState: () => ({ open: false }), resetCircuit() {} };
  const leakedPath = path.join(root, 'credentials', 'box', 'credentials.json');
  const mailClient = {
    async listMailbox() {
      const error = new Error(`provider failed apiKey="am_private_12345678" at ${leakedPath}`);
      error.name = 'MailClientError';
      error.statusCode = 502;
      error.code = 'mail_provider_error';
      throw error;
    },
  };
  const job = store.createJob({ count: 1, prefix: '', usernames: ['errorbox111'] });
  const item = store.markItemRunning(job.items[0].id);
  const mailboxId = store.markItemSucceeded(item.id, {
    username: item.username, email: `${item.username}@atomicmail.ai`, inboxId: item.username, credentialsPath: leakedPath,
  });
  const server = createServer({ store, worker, config: { ...makeConfig(root, ''), mailMaxSearchBytes: 64 }, mailClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/mailboxes/${mailboxId}/mail`);
    assert.equal(response.status, 502);
    const raw = await response.text();
    assert.doesNotMatch(raw, /am_private_12345678|credentials\.json/i);
    assert.match(raw, /API_KEY_REDACTED|CREDENTIAL_PATH_REDACTED/);
    const audit = JSON.stringify(store.recentAudit(20));
    assert.doesNotMatch(audit, /am_private_12345678|credentials\.json/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Atomic Mail 429 is a temporary friendly response with Retry-After and no red error audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-mail-rate-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const worker = { circuitState: () => ({ open: false }), resetCircuit() {} };
  const mailClient = {
    async listMailbox() {
      const error = new Error('Atomic Mail is temporarily rate limiting requests. Retrying automatically…');
      error.name = 'MailClientError';
      error.statusCode = 429;
      error.code = 'mail_rate_limited';
      error.retryAfterMs = 2400;
      error.retryAt = new Date(Date.now() + 2400).toISOString();
      throw error;
    },
  };
  const job = store.createJob({ count: 1, prefix: '', usernames: ['ratelimit111'] });
  const item = store.markItemRunning(job.items[0].id);
  const mailboxId = store.markItemSucceeded(item.id, {
    username: item.username,
    email: `${item.username}@atomicmail.ai`,
    inboxId: item.username,
    credentialsPath: path.join(root, 'credentials', item.username, 'credentials.json.enc'),
  });
  const server = createServer({ store, worker, config: makeConfig(root, ''), mailClient });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mailboxes/${mailboxId}/mail`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '3');
    const body = await response.json();
    assert.equal(body.code, 'mail_rate_limited');
    assert.equal(body.temporary, true);
    assert.equal(body.retryAfterMs, 2400);
    assert.match(body.error, /temporarily rate limiting/i);
    assert.doesNotMatch(JSON.stringify(store.recentAudit(20)), /mail\.operation_failed/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
