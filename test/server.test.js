import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { createServer } from '../src/server.js';

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
