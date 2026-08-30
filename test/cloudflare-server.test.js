import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import { CloudflareManualService } from '../src/cloudflare-manual-service.js';
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
    cloudflareEnabled: true, cloudflareMaxBatchSize: 100, cloudflareVerificationLookbackMs: 600000,
  };
}

test('manual Cloudflare API protects secrets, transitions safely, exports explicitly, and retires runner endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-cloudflare-server-'));
  const cfg = config(root);
  const store = new Store(path.join(root, 'panel.sqlite'));
  const vault = new CredentialVault(cfg);
  vault.initialize();
  const now = new Date().toISOString();
  for (let index = 1; index <= 2; index += 1) {
    const username = `mailboxapi${index}`;
    store.db.prepare(`
      INSERT INTO mailboxes(id, username, email, inbox_id, credentials_path, status, created_at)
      VALUES(?, ?, ?, ?, 'safe.enc', 'active', ?)
    `).run(`mbx_api_${index}`, username, `${username}@atomicmail.ai`, username, now);
  }
  const mailClient = {
    async findCloudflareVerification(username, options) {
      assert.equal(username, 'mailboxapi1');
      assert.equal(options.recipient, 'mailboxapi1@atomicmail.ai');
      assert.equal(options.lookbackMs, 600000);
      return {
        messageId: 'trusted-message', subject: 'Your login verification code', receivedAt: new Date().toISOString(),
        url: 'https://dash.cloudflare.com/verify-email?token=api-secret-link', code: '7286934',
      };
    },
  };
  const cloudflareManualService = new CloudflareManualService({ store, vault, mailClient, config: cfg });
  const worker = { circuitState: () => ({ open: false }), resetCircuit() {} };
  const server = createServer({ store, worker, config: cfg, vault, mailClient, cloudflareManualService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const eligibleBefore = await (await fetch(`${base}/api/cloudflare/eligible-mailboxes?limit=100`)).json();
    assert.deepEqual(eligibleBefore.items.map((item) => item.id), ['mbx_api_1', 'mbx_api_2']);

    const createdResponse = await fetch(`${base}/api/cloudflare/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxIds: ['mbx_api_1', 'mbx_api_2'] }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.requested_count, 2);
    assert.doesNotMatch(JSON.stringify(created), /password_ciphertext|verification_url_ciphertext|api-secret-link/);

    const focus = await (await fetch(`${base}/api/cloudflare/focus`)).json();
    assert.equal(focus.account.email, 'mailboxapi1@atomicmail.ai');
    assert.equal(focus.account.status, 'not_started');
    assert.equal(focus.account.position, 1);
    assert.equal(focus.account.batch_total, 2);
    assert.doesNotMatch(JSON.stringify(focus), /password_ciphertext|verification_url_ciphertext/);

    const accountId = focus.account.id;
    const revealed = await fetch(`${base}/api/cloudflare/accounts/${accountId}/password`, { method: 'POST', body: '{}' });
    assert.equal(revealed.status, 200);
    const password = (await revealed.json()).password;
    assert.equal(password.length, 20);

    const regenerated = await fetch(`${base}/api/cloudflare/accounts/${accountId}/regenerate-password`, { method: 'POST', body: '{}' });
    assert.equal(regenerated.status, 200);
    const regeneratedPassword = (await regenerated.json()).password;
    assert.notEqual(regeneratedPassword, password);

    const signup = await fetch(`${base}/api/cloudflare/accounts/${accountId}/signup-done`, { method: 'POST', body: '{}' });
    assert.equal(signup.status, 200);
    const locked = await fetch(`${base}/api/cloudflare/accounts/${accountId}/regenerate-password`, { method: 'POST', body: '{}' });
    assert.equal(locked.status, 409);

    const globalApiKey = 'cfk_SERVER_TEST_abcdefghijklmnopqrstuvwxyz012345';
    const apiToken = 'cfat_SERVER_TEST_abcdefghijklmnopqrstuvwxyz0123456789';
    const saveGlobalKey = await fetch(`${base}/api/cloudflare/accounts/${accountId}/access-secrets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ globalApiKey }),
    });
    assert.equal(saveGlobalKey.status, 200);
    const partiallySavedAccount = (await saveGlobalKey.json()).account;
    assert.equal(partiallySavedAccount.has_global_api_key, 1);
    assert.equal(partiallySavedAccount.has_api_token, 0);
    assert.doesNotMatch(JSON.stringify(partiallySavedAccount), /SERVER_TEST|ciphertext/);

    const inbox = await fetch(`${base}/api/cloudflare/accounts/${accountId}/check-inbox`, { method: 'POST', body: '{}' });
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json()).found, true);
    const normalAccounts = await (await fetch(`${base}/api/cloudflare/accounts`)).json();
    assert.doesNotMatch(JSON.stringify(normalAccounts), /api-secret-link|SERVER_TEST|password_ciphertext|verification_url_ciphertext|verification_code_ciphertext|global_api_key_ciphertext|api_token_ciphertext/);
    const link = await fetch(`${base}/api/cloudflare/accounts/${accountId}/verification-link`, { method: 'POST', body: '{}' });
    assert.equal(link.status, 200);
    assert.equal((await link.json()).verificationUrl, 'https://dash.cloudflare.com/verify-email?token=api-secret-link');

    const code = await fetch(`${base}/api/cloudflare/accounts/${accountId}/verification-code`, { method: 'POST', body: '{}' });
    assert.equal(code.status, 200);
    assert.equal((await code.json()).verificationCode, '7286934');

    const incomplete = await fetch(`${base}/api/cloudflare/accounts/${accountId}/verified`, { method: 'POST', body: '{}' });
    assert.equal(incomplete.status, 409);
    assert.equal((await incomplete.json()).code, 'cloudflare_access_secrets_incomplete');

    const saveApiToken = await fetch(`${base}/api/cloudflare/accounts/${accountId}/access-secrets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiToken }),
    });
    assert.equal(saveApiToken.status, 200);
    const savedAccount = (await saveApiToken.json()).account;
    assert.equal(savedAccount.has_global_api_key, 1);
    assert.equal(savedAccount.has_api_token, 1);
    const revealSecrets = await fetch(`${base}/api/cloudflare/accounts/${accountId}/access-secrets/reveal`, { method: 'POST', body: '{}' });
    assert.equal(revealSecrets.status, 200);
    assert.deepEqual(await revealSecrets.json(), { globalApiKey, apiToken });

    const verified = await fetch(`${base}/api/cloudflare/accounts/${accountId}/verified`, { method: 'POST', body: '{}' });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).next.account.email, 'mailboxapi2@atomicmail.ai');

    const duplicate = await fetch(`${base}/api/cloudflare/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxIds: ['mbx_api_1'] }),
    });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already used/i);

    const deniedExport = await fetch(`${base}/api/cloudflare/accounts/export-sensitive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(deniedExport.status, 400);
    const exportResponse = await fetch(`${base}/api/cloudflare/accounts/export-sensitive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'EXPORT CLOUDFLARE' }),
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('cache-control') || '', /no-store/);
    const csv = await exportResponse.text();
    assert.match(csv, /^"Email","Password","GlobalApiKey","ApiToken","Status"/);
    assert.ok(csv.includes(regeneratedPassword));
    assert.ok(csv.includes(globalApiKey));
    assert.ok(csv.includes(apiToken));

    const auditJson = JSON.stringify(store.recentAudit(100));
    assert.equal(auditJson.includes(regeneratedPassword), false);
    assert.doesNotMatch(auditJson, /api-secret-link|SERVER_TEST/);
    const runner = await fetch(`${base}/api/cloudflare/runner/tasks/next?wait=0`);
    assert.equal(runner.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
