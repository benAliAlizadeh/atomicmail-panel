import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import {
  CloudflareManualService,
  generateCloudflareAccountPassword,
} from '../src/cloudflare-manual-service.js';

function fixture({ mailClient = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-cloudflare-manual-'));
  const config = {
    credentialsRoot: path.join(root, 'credentials'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
    cloudflareMaxBatchSize: 100,
    cloudflareVerificationLookbackMs: 600000,
    exportMaxRows: 1000,
  };
  const store = new Store(path.join(root, 'panel.sqlite'));
  const vault = new CredentialVault(config);
  vault.initialize();
  const now = new Date().toISOString();
  for (let index = 1; index <= 4; index += 1) {
    const username = `manualuser${index}`;
    store.db.prepare(`
      INSERT INTO mailboxes(id, username, email, inbox_id, credentials_path, status, created_at)
      VALUES(?, ?, ?, ?, ?, 'active', ?)
    `).run(`mbx_${index}`, username, `${username}@atomicmail.ai`, username, `safe-${index}.enc`, now);
  }
  const service = new CloudflareManualService({ store, vault, mailClient, config });
  return {
    root, config, store, vault, service,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('manual Cloudflare passwords are 20 characters, unique, and satisfy every character class', () => {
  const passwords = new Set(Array.from({ length: 250 }, () => generateCloudflareAccountPassword()));
  assert.equal(passwords.size, 250);
  for (const password of passwords) {
    assert.equal(password.length, 20);
    assert.match(password, /^[A-Z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*_.+=?-]/);
  }
});


test('Cloudflare Focus reuses the exact password already saved for the selected email', () => {
  const current = fixture();
  try {
    const password = 'Exact!Mailbox-Cloudflare-7722';
    current.store.db.prepare(`
      UPDATE mailboxes SET account_password_ciphertext=? WHERE id='mbx_1'
    `).run(current.vault.sealMailboxPassword(password, 'mbx_1'));
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    assert.equal(account.mailbox_id, 'mbx_1');
    assert.equal(current.service.revealPassword(account.id), password);
    const mailbox = current.store.getMailboxPasswordCiphertext('mbx_1');
    assert.equal(
      current.vault.openMailboxPassword(mailbox.account_password_ciphertext, mailbox.mailbox_id),
      password,
    );
  } finally {
    current.close();
  }
});

test('startup links an existing manual Cloudflare password back to its mailbox without changing it', () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_existing_manual';
    const accountId = 'cfacct_existing_manual';
    const password = 'Existing!Cloudflare-Password-8822';
    const now = new Date().toISOString();
    const markerCiphertext = current.vault.sealCloudflareSecret('manual-assistant-v1', {
      purpose: 'cloudflare-job-password', id: jobId,
    });
    const passwordCiphertext = current.vault.sealCloudflareSecret(password, {
      purpose: 'cloudflare-account-password', id: accountId,
    });
    current.store.db.prepare(`
      INSERT INTO cloudflare_jobs(id, requested_count, password_mode, password_ciphertext, status, created_at, updated_at)
      VALUES(?, 1, 'per_account_generated', ?, 'running', ?, ?)
    `).run(jobId, markerCiphertext, now, now);
    current.store.db.prepare(`
      INSERT INTO cloudflare_accounts(
        id, mailbox_id, email, credential_job_id, status, password_ciphertext,
        notes, workflow_mode, created_at, updated_at
      ) VALUES(?, 'mbx_1', 'manualuser1@atomicmail.ai', ?, 'not_started', ?, '', 'manual', ?, ?)
    `).run(accountId, jobId, passwordCiphertext, now, now);

    assert.equal(current.store.getMailboxPasswordCiphertext('mbx_1').account_password_ciphertext, null);
    assert.deepEqual(current.service.initialize(), { migrated: 0, legacyCredentialsPreserved: 0, failures: 0 });
    const mailbox = current.store.getMailboxPasswordCiphertext('mbx_1');
    assert.equal(
      current.vault.openMailboxPassword(mailbox.account_password_ciphertext, mailbox.mailbox_id),
      password,
    );
    assert.equal(current.service.revealPassword(accountId), password);
  } finally {
    current.close();
  }
});

test('manual batch encrypts a different password per account and blocks duplicate email reuse', () => {
  const current = fixture();
  try {
    const batch = current.service.createBatch(['mbx_1', 'mbx_2', 'mbx_3']);
    assert.equal(batch.requested_count, 3);
    const accounts = current.service.listAccounts({ limit: 10 });
    assert.equal(accounts.length, 3);
    assert.doesNotMatch(JSON.stringify(accounts), /password_ciphertext|verification_url_ciphertext/);
    const passwords = accounts.map((account) => current.service.revealPassword(account.id));
    assert.equal(new Set(passwords).size, 3);
    const raw = current.store.db.prepare(`
      SELECT id, mailbox_id, password_ciphertext FROM cloudflare_accounts ORDER BY created_at, id
    `).all();
    for (const row of raw) {
      const account = accounts.find((candidate) => candidate.id === row.id);
      const password = current.service.revealPassword(row.id);
      const mailbox = current.store.getMailboxPasswordCiphertext(row.mailbox_id);
      assert.ok(account);
      assert.ok(row.password_ciphertext);
      assert.doesNotMatch(row.password_ciphertext, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(current.vault.openCloudflareSecret(row.password_ciphertext, {
        purpose: 'cloudflare-account-password', id: row.id,
      }), password);
      assert.equal(
        current.vault.openMailboxPassword(mailbox.account_password_ciphertext, mailbox.mailbox_id),
        password,
      );
      assert.throws(() => current.vault.openCloudflareSecret(row.password_ciphertext, {
        purpose: 'cloudflare-account-password', id: 'wrong-account',
      }), /authenticated|wrong|corrupted/i);
    }
    assert.throws(
      () => current.service.createBatch(['mbx_1']),
      (error) => error.statusCode === 409 && error.code === 'cloudflare_account_tracked',
    );
    assert.deepEqual(current.service.listEligibleMailboxes(100).map((row) => row.id), ['mbx_4']);
  } finally {
    current.close();
  }
});

test('password regeneration locks after Signup Done and Focus Mode resumes after restart', () => {
  const current = fixture();
  try {
    current.service.createBatch(['mbx_1', 'mbx_2']);
    const first = current.service.getFocusAccount().account;
    const original = current.service.revealPassword(first.id);
    const regenerated = current.service.regeneratePassword(first.id);
    assert.notEqual(regenerated.password, original);
    const mailboxPassword = current.store.getMailboxPasswordCiphertext(first.mailbox_id);
    assert.equal(
      current.vault.openMailboxPassword(mailboxPassword.account_password_ciphertext, mailboxPassword.mailbox_id),
      regenerated.password,
    );
    const signedUp = current.service.markSignupDone(first.id);
    assert.equal(signedUp.status, 'signup_done');
    assert.ok(signedUp.password_locked_at);
    assert.throws(
      () => current.service.regeneratePassword(first.id),
      (error) => error.statusCode === 409 && error.code === 'cloudflare_password_locked',
    );

    const restarted = new CloudflareManualService({
      store: current.store, vault: current.vault, config: current.config,
    });
    assert.deepEqual(restarted.initialize(), { migrated: 0, legacyCredentialsPreserved: 0, failures: 0 });
    const resumed = restarted.getFocusAccount().account;
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.status, 'signup_done');
    assert.equal(restarted.revealPassword(first.id), regenerated.password);
    const restartedMailboxPassword = current.store.getMailboxPasswordCiphertext(first.mailbox_id);
    assert.equal(
      current.vault.openMailboxPassword(
        restartedMailboxPassword.account_password_ciphertext,
        restartedMailboxPassword.mailbox_id,
      ),
      regenerated.password,
    );
  } finally {
    current.close();
  }
});

test('Inbox check uses the saved signup window and stores only a safe encrypted Cloudflare link', async () => {
  let call = null;
  const current = fixture({
    mailClient: {
      async findCloudflareVerification(username, options) {
        call = { username, ...options };
        return {
          messageId: 'message-1',
          receivedAt: new Date().toISOString(),
          url: 'https://dash.cloudflare.com/verify-email?token=trusted-secret',
        };
      },
    },
  });
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    current.service.markSignupDone(account.id);
    const checked = await current.service.checkInbox(account.id);
    assert.equal(checked.found, true);
    assert.equal(checked.account.status, 'verification_received');
    assert.equal(call.username, 'manualuser1');
    assert.equal(call.recipient, 'manualuser1@atomicmail.ai');
    assert.equal(call.submittedAt, checked.account.signup_done_at);
    assert.equal(call.lookbackMs, 600000);
    assert.equal(call.priority, 'interactive');
    assert.equal(current.service.revealVerificationLink(account.id), 'https://dash.cloudflare.com/verify-email?token=trusted-secret');
    const raw = current.store.db.prepare(`
      SELECT verification_url_ciphertext FROM cloudflare_accounts WHERE id=?
    `).get(account.id);
    assert.ok(raw.verification_url_ciphertext);
    assert.doesNotMatch(raw.verification_url_ciphertext, /trusted-secret/);
    assert.throws(
      () => current.service.markVerified(account.id),
      (error) => error.statusCode === 409 && error.code === 'cloudflare_access_secrets_incomplete',
    );
    current.service.saveAccessSecrets(account.id, {
      globalApiKey: 'cfk_LINK_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
      apiToken: 'cfat_LINK_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const verified = current.service.markVerified(account.id);
    assert.equal(verified.account.status, 'verified');
    assert.ok(verified.account.verified_at);
  } finally {
    current.close();
  }
});

test('unsafe verification links are rejected and never persisted', async () => {
  const current = fixture({
    mailClient: {
      async findCloudflareVerification() {
        return { receivedAt: new Date().toISOString(), url: 'https://cloudflare.com.evil.example/verify-email?token=x' };
      },
    },
  });
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    current.service.markSignupDone(account.id);
    await assert.rejects(
      current.service.checkInbox(account.id),
      (error) => error.statusCode === 422 && error.code === 'unsafe_cloudflare_verification_url',
    );
    const raw = current.store.db.prepare(`SELECT verification_url_ciphertext FROM cloudflare_accounts WHERE id=?`).get(account.id);
    assert.equal(raw.verification_url_ciphertext, null);
  } finally {
    current.close();
  }
});

test('Inbox check accepts a trusted Cloudflare login code without requiring a verification link', async () => {
  const current = fixture({
    mailClient: {
      async findCloudflareVerification() {
        return {
          messageId: 'message-code',
          subject: 'Your login verification code',
          receivedAt: new Date().toISOString(),
          code: '7286934',
          url: null,
        };
      },
    },
  });
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    current.service.markSignupDone(account.id);
    const checked = await current.service.checkInbox(account.id);
    assert.equal(checked.found, true);
    assert.equal(checked.evidence.verificationCode, '7286934');
    assert.equal(checked.evidence.verificationUrl, null);
    assert.equal(checked.account.status, 'verification_received');
    assert.equal(checked.account.has_verification_code, 1);
    assert.equal(checked.account.has_verification_link, 0);
    assert.equal(checked.account.verification_subject, 'Your login verification code');
    assert.equal(current.service.revealVerificationCode(account.id), '7286934');
    const raw = current.store.db.prepare(`
      SELECT verification_code_ciphertext FROM cloudflare_accounts WHERE id=?
    `).get(account.id);
    assert.ok(raw.verification_code_ciphertext);
    assert.doesNotMatch(raw.verification_code_ciphertext, /7286934/);
    current.service.saveAccessSecrets(account.id, {
      globalApiKey: 'cfk_CODE_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
      apiToken: 'cfut_CODE_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    assert.equal(current.service.markVerified(account.id).account.status, 'verified');
  } finally {
    current.close();
  }
});

test('rechecking Inbox preserves stored evidence even when no newer Cloudflare email is found', async () => {
  let attempt = 0;
  const current = fixture({
    mailClient: {
      async findCloudflareVerification() {
        attempt += 1;
        if (attempt === 1) {
          return {
            messageId: 'message-link', subject: 'Verify your email', receivedAt: new Date().toISOString(),
            url: 'https://dash.cloudflare.com/verify-email?token=preserve-link', code: null,
          };
        }
        if (attempt === 2) {
          return {
            messageId: 'message-code', subject: 'Your login verification code', receivedAt: new Date().toISOString(),
            url: null, code: '7654321',
          };
        }
        return null;
      },
    },
  });
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    current.service.markSignupDone(account.id);
    await current.service.checkInbox(account.id);
    await current.service.checkInbox(account.id);
    const noNewMessage = await current.service.checkInbox(account.id);
    const updated = current.service.getAccount(account.id);
    assert.equal(noNewMessage.found, false);
    assert.equal(noNewMessage.retainedEvidence, true);
    assert.equal(noNewMessage.account.status, 'verification_received');
    assert.equal(updated.status, 'verification_received');
    assert.equal(updated.has_verification_link, 1);
    assert.equal(updated.has_verification_code, 1);
    assert.equal(current.service.revealVerificationLink(account.id), 'https://dash.cloudflare.com/verify-email?token=preserve-link');
    assert.equal(current.service.revealVerificationCode(account.id), '7654321');
  } finally {
    current.close();
  }
});

test('startup repairs AM-38 waiting state when encrypted verification evidence already exists', async () => {
  const current = fixture({
    mailClient: {
      async findCloudflareVerification() {
        return {
          messageId: 'message-repair', subject: 'Your login verification code', receivedAt: new Date().toISOString(),
          url: null, code: '824611',
        };
      },
    },
  });
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    current.service.markSignupDone(account.id);
    await current.service.checkInbox(account.id);
    current.store.db.prepare(`UPDATE cloudflare_accounts SET status='waiting_verification' WHERE id=?`).run(account.id);
    current.store.db.prepare(`UPDATE cloudflare_job_items SET status='waiting_verification', phase='waiting_verification' WHERE account_id=?`).run(account.id);

    const restarted = new CloudflareManualService({
      store: current.store,
      vault: current.vault,
      mailClient: current.service.mailClient,
      config: current.config,
    });
    assert.deepEqual(restarted.initialize(), { migrated: 0, legacyCredentialsPreserved: 0, failures: 0 });
    const repaired = restarted.getAccount(account.id);
    const repairedItem = current.store.db.prepare(`SELECT status, phase FROM cloudflare_job_items WHERE account_id=?`).get(account.id);
    assert.equal(repaired.status, 'verification_received');
    assert.equal(repairedItem.status, 'verification_received');
    assert.equal(repairedItem.phase, 'verification_received');
    assert.equal(restarted.revealVerificationCode(account.id), '824611');

    restarted.saveAccessSecrets(account.id, {
      globalApiKey: 'cfk_REPAIR_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
      apiToken: 'cfat_REPAIR_TEST_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    assert.equal(restarted.markVerified(account.id).account.status, 'verified');
  } finally {
    current.close();
  }
});

test('Cloudflare API key and API token are encrypted per account and included only in explicit secret output', () => {
  const current = fixture();
  try {
    current.service.createBatch(['mbx_1']);
    const account = current.service.getFocusAccount().account;
    const globalApiKey = 'cfk_TESTGlobalApiKey_abcdefghijklmnopqrstuvwxyz012345';
    const apiToken = 'cfat_TESTApiToken_abcdefghijklmnopqrstuvwxyz0123456789';
    const saved = current.service.saveAccessSecrets(account.id, { globalApiKey, apiToken });
    assert.equal(saved.has_global_api_key, 1);
    assert.equal(saved.has_api_token, 1);
    assert.doesNotMatch(JSON.stringify(saved), /TESTGlobalApiKey|TESTApiToken|global_api_key_ciphertext|api_token_ciphertext/);
    assert.deepEqual(current.service.revealAccessSecrets(account.id), { globalApiKey, apiToken });

    const raw = current.store.db.prepare(`
      SELECT global_api_key_ciphertext, api_token_ciphertext FROM cloudflare_accounts WHERE id=?
    `).get(account.id);
    assert.ok(raw.global_api_key_ciphertext);
    assert.ok(raw.api_token_ciphertext);
    assert.doesNotMatch(raw.global_api_key_ciphertext, /TESTGlobalApiKey/);
    assert.doesNotMatch(raw.api_token_ciphertext, /TESTApiToken/);

    const publicRows = current.service.listAccounts({ limit: 10 });
    assert.doesNotMatch(JSON.stringify(publicRows), /TESTGlobalApiKey|TESTApiToken|ciphertext/);
    const exported = current.service.exportSensitive();
    assert.equal(exported[0].globalApiKey, globalApiKey);
    assert.equal(exported[0].apiToken, apiToken);
    assert.throws(
      () => current.service.saveAccessSecrets(account.id, { globalApiKey: apiToken }),
      (error) => error.code === 'cloudflare_secret_type_mismatch',
    );
    assert.throws(
      () => current.service.saveAccessSecrets(account.id, { globalApiKey: 'cfut_WRONG_FIELD_abcdefghijklmnopqrstuvwxyz0123456789' }),
      (error) => error.code === 'cloudflare_secret_type_mismatch',
    );
    assert.throws(
      () => current.service.saveAccessSecrets(account.id, { apiToken: globalApiKey }),
      (error) => error.code === 'cloudflare_secret_type_mismatch',
    );
  } finally {
    current.close();
  }
});

test('legacy runner records migrate additively without changing a used external password', () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_legacy_manual_migration';
    const accountId = 'cfacct_legacy_manual_migration';
    const itemId = 'cfitem_legacy_manual_migration';
    const password = 'Legacy!Shared-Password-8877';
    const now = new Date().toISOString();
    const ciphertext = current.vault.sealCloudflareSecret(password, { purpose: 'cloudflare-job-password', id: jobId });
    current.store.db.prepare(`
      INSERT INTO cloudflare_jobs(id, requested_count, password_mode, password_ciphertext, status, created_at, updated_at)
      VALUES(?, 1, 'manual', ?, 'running', ?, ?)
    `).run(jobId, ciphertext, now, now);
    current.store.db.prepare(`
      INSERT INTO cloudflare_accounts(id, mailbox_id, email, credential_job_id, status, created_at, updated_at)
      VALUES(?, 'mbx_1', 'manualuser1@atomicmail.ai', ?, 'waiting_for_verification', ?, ?)
    `).run(accountId, jobId, now, now);
    current.store.db.prepare(`
      INSERT INTO cloudflare_job_items(id, job_id, account_id, mailbox_id, position, email, status, phase,
        next_attempt_at, submitted_at, created_at, updated_at)
      VALUES(?, ?, ?, 'mbx_1', 1, 'manualuser1@atomicmail.ai', 'waiting_for_verification',
        'waiting_for_verification', ?, ?, ?, ?)
    `).run(itemId, jobId, accountId, now, now, now, now);
    const migration = current.service.initialize();
    assert.deepEqual(migration, { migrated: 1, legacyCredentialsPreserved: 1, failures: 0 });
    const migrated = current.service.getAccount(accountId);
    assert.equal(migrated.status, 'waiting_verification');
    assert.equal(migrated.workflow_mode, undefined);
    assert.equal(current.service.revealPassword(accountId), password);
    const mailboxPassword = current.store.getMailboxPasswordCiphertext('mbx_1');
    assert.equal(
      current.vault.openMailboxPassword(mailboxPassword.account_password_ciphertext, mailboxPassword.mailbox_id),
      password,
    );
  } finally {
    current.close();
  }
});

test('pre-assistant databases receive additive account columns without deleting existing rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-cloudflare-additive-'));
  const dbPath = path.join(root, 'panel.sqlite');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE cloudflare_accounts (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        credential_job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cloudflare_account_id TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error_code TEXT,
        last_error TEXT
      );
      INSERT INTO cloudflare_accounts(
        id, mailbox_id, email, credential_job_id, status, created_at, updated_at
      ) VALUES(
        'legacy-account', 'legacy-mailbox', 'legacy@atomicmail.ai', 'legacy-job',
        'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    const columns = new Set(migrated.db.prepare('PRAGMA table_info(cloudflare_accounts)').all().map((row) => row.name));
    for (const column of [
      'password_ciphertext', 'notes', 'signup_done_at', 'verification_received_at',
      'verification_url_ciphertext', 'verification_code_ciphertext', 'verification_message_id',
      'verification_subject', 'global_api_key_ciphertext', 'api_token_ciphertext', 'secrets_updated_at',
      'last_inbox_check_at', 'failed_at', 'password_locked_at', 'workflow_mode',
    ]) assert.equal(columns.has(column), true, `missing additive column ${column}`);
    const row = migrated.db.prepare('SELECT id, email, status, notes, workflow_mode FROM cloudflare_accounts').get();
    assert.deepEqual({ ...row }, {
      id: 'legacy-account', email: 'legacy@atomicmail.ai', status: 'queued', notes: '', workflow_mode: 'runner_legacy',
    });
    migrated.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
