import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import { CloudflareStore } from '../src/cloudflare-store.js';
import { CloudflareRunnerManager } from '../src/cloudflare-runner-manager.js';
import { createServer } from '../src/server.js';

function config(root) {
  return {
    host: '127.0.0.1', port: 0,
    adminUsername: 'admin', adminPassword: '', adminSessionTtlMs: 3600000,
    adminLoginMaxAttempts: 5, adminLoginWindowMs: 60000, adminCookieSecure: false,
    maxBatchSize: 100, usernameMinLength: 10, usernameMaxLength: 14, exportMaxRows: 1000,
    workerEnabled: true, registerTimeoutMs: 180000, postSuccessDelayMs: 5000,
    mailCommandTimeoutMs: 60000, mailAutoRefreshSeconds: 45, mailInboxLimit: 50,
    mailMaxComposeBytes: 204800, mailMaxAttachmentCount: 5, mailMaxAttachmentBytes: 5242880,
    mailMaxTotalAttachmentBytes: 10485760, destinationPasswordMaxBytes: 1024,
    credentialsRoot: path.join(root, 'credentials'), runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'), encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
    cloudflareEnabled: true, cloudflareMaxBatchSize: 100, cloudflarePairingTtlMs: 600000,
    cloudflareRunnerOfflineMs: 45000, cloudflareTrustProxy: false,
  };
}

test('Cloudflare admin API keeps secrets out of normal responses and explicitly protects export/reveal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-cloudflare-server-'));
  const cfg = config(root);
  const store = new Store(path.join(root, 'panel.sqlite'));
  const vault = new CredentialVault(cfg);
  vault.initialize();
  const cloudflareStore = new CloudflareStore(store);
  const runnerManager = new CloudflareRunnerManager({ config: cfg, store });
  const orchestrator = {
    circuitState: () => ({ open: false, until: null, reason: null }),
    status: () => ({ enabled: true, runner: runnerManager.status(), circuit: { open: false }, limits: { maxBatchSize: 100 } }),
    resetCircuit() {},
    claimTask: () => null,
    heartbeat: (session, body) => runnerManager.heartbeat(session, body),
    handleRunnerEvent() { throw new Error('No task'); },
  };
  const worker = { circuitState: () => ({ open: false }), resetCircuit() {} };
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO mailboxes(id, username, email, inbox_id, credentials_path, status, created_at)
    VALUES('mbx_api', 'mailboxapi1', 'mailboxapi1@atomicmail.ai', 'mailboxapi1', 'safe.enc', 'active', ?)
  `).run(now);
  const server = createServer({
    store, worker, config: cfg, vault, cloudflareStore, cloudflareOrchestrator: orchestrator, runnerManager,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const eligibleBefore = await (await fetch(`${base}/api/cloudflare/eligible-mailboxes?limit=100&search=mailboxapi1`)).json();
    assert.deepEqual(eligibleBefore.items.map((item) => item.id), ['mbx_api']);
    const createdResponse = await fetch(`${base}/api/cloudflare/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxIds: ['mbx_api'], passwordMode: 'generated' }),
    });
    assert.equal(createdResponse.status, 201);
    const job = await createdResponse.json();
    const normalJson = JSON.stringify(job);
    assert.doesNotMatch(normalJson, /password_ciphertext|browser_state_ciphertext|verification_url_ciphertext/);
    assert.equal(Object.hasOwn(cloudflareStore.getItem(job.items[0].id), 'password_ciphertext'), false);
    assert.equal(Object.hasOwn(cloudflareStore.getItem(job.items[0].id, { includeSecrets: true }), 'password_ciphertext'), true);

    const revealed = await fetch(`${base}/api/cloudflare/jobs/${job.id}/password`, { method: 'POST', body: '{}' });
    assert.equal(revealed.status, 200);
    const password = (await revealed.json()).password;
    assert.equal(password.length, 24);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*()_+\-=]/);

    const accounts = await (await fetch(`${base}/api/cloudflare/accounts`)).json();
    assert.equal(accounts.items[0].email, 'mailboxapi1@atomicmail.ai');
    assert.doesNotMatch(JSON.stringify(accounts), new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const deniedExport = await fetch(`${base}/api/cloudflare/accounts/export-sensitive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(deniedExport.status, 400);
    const exportResponse = await fetch(`${base}/api/cloudflare/accounts/export-sensitive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'EXPORT CLOUDFLARE' }),
    });
    assert.equal(exportResponse.status, 200);
    assert.match(await exportResponse.text(), new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const mailbox = await (await fetch(`${base}/api/mailboxes?limit=10&offset=0`)).json();
    assert.equal(mailbox.items[0].cloudflare_eligible, 0);
    assert.equal(mailbox.items[0].cloudflare_status, 'queued');
    const eligibleAfter = await (await fetch(`${base}/api/cloudflare/eligible-mailboxes?limit=100&search=mailboxapi1`)).json();
    assert.deepEqual(eligibleAfter.items, []);

    const pairing = await (await fetch(`${base}/api/cloudflare/runners/pairing`, { method: 'POST', body: '{}' })).json();
    const pairedResponse = await fetch(`${base}/api/cloudflare/runner/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, protocolVersion: pairing.protocolVersion, name: 'API runner' }),
    });
    assert.equal(pairedResponse.status, 201);
    const paired = await pairedResponse.json();
    const taskResponse = await fetch(`${base}/api/cloudflare/runner/tasks/next?wait=0`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    assert.equal(taskResponse.status, 200);
    assert.deepEqual(await taskResponse.json(), { task: null });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
