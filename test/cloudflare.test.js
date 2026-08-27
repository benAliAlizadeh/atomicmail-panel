import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import { CloudflareStore } from '../src/cloudflare-store.js';
import { CloudflareRunnerManager, CLOUDFLARE_RUNNER_PROTOCOL } from '../src/cloudflare-runner-manager.js';
import { CloudflareOrchestrator } from '../src/cloudflare-orchestrator.js';
import { CloudflareArtifactStore } from '../src/cloudflare-artifacts.js';
import {
  isCloudflareSender,
  isCloudflareVerificationUrl,
  selectCloudflareVerification,
} from '../src/cloudflare-verification.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-cloudflare-'));
  const config = {
    credentialsRoot: path.join(root, 'credentials'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
    cloudflarePairingTtlMs: 600000,
    cloudflareRunnerOfflineMs: 45000,
    cloudflareTrustProxy: false,
    adminPassword: '',
  };
  const store = new Store(path.join(root, 'panel.sqlite'));
  const vault = new CredentialVault(config);
  vault.initialize();
  const cloudflareStore = new CloudflareStore(store);
  const now = new Date().toISOString();
  for (let index = 1; index <= 3; index += 1) {
    store.db.prepare(`
      INSERT INTO mailboxes(id, username, email, inbox_id, credentials_path, status, created_at)
      VALUES(?, ?, ?, ?, ?, 'active', ?)
    `).run(`mbx_${index}`, `mailboxuser${index}`, `mailboxuser${index}@atomicmail.ai`, `mailboxuser${index}`,
      path.join(root, 'credentials', `mailboxuser${index}`, 'credentials.json.enc'), now);
  }
  return {
    root, config, store, vault, cloudflareStore,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Cloudflare job state machine is isolated, lease-fenced and clears browser secrets after verification', () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_1234567890abcdef1234567890abcdef';
    const passwordCiphertext = current.vault.sealCloudflareSecret('Strong!Shared-Password-3388', {
      purpose: 'cloudflare-job-password', id: jobId,
    });
    assert.throws(
      () => current.cloudflareStore.createJob({
        id: 'cfjob_too_many', mailboxIds: Array.from({ length: 101 }, (_, index) => `missing_${index}`),
        passwordMode: 'manual', passwordCiphertext,
      }),
      (error) => error.statusCode === 400,
    );
    const job = current.cloudflareStore.createJob({
      id: jobId, mailboxIds: ['mbx_1', 'mbx_2'], passwordMode: 'manual', passwordCiphertext,
    });
    assert.equal(job.requested_count, 2);
    assert.deepEqual(current.cloudflareStore.listEligibleMailboxes(100).map((item) => item.id), ['mbx_3']);
    assert.equal(job.has_password, 1);
    assert.doesNotMatch(JSON.stringify(job), /Strong!Shared|password_ciphertext|browser_state_ciphertext/);

    const preparing = current.cloudflareStore.beginNextSignup();
    assert.equal(preparing.status, 'preparing');
    const signup = current.cloudflareStore.claimRunnerTask('runner-one', 60000);
    assert.equal(signup.status, 'creating');
    assert.equal(current.cloudflareStore.validateLease(signup.id, 'runner-one', signup.lease_generation), true);
    assert.equal(current.cloudflareStore.validateLease(signup.id, 'runner-one', signup.lease_generation - 1), false);

    const browserState = current.vault.sealCloudflareSecret(JSON.stringify({ cookies: [{ name: 'session' }] }), {
      purpose: 'cloudflare-browser-state', id: signup.id,
    });
    current.cloudflareStore.markAwaitingSubmit(signup.id, 'runner-one', signup.lease_generation, browserState);
    current.cloudflareStore.markSubmitted(signup.id, 'runner-one', signup.lease_generation, browserState);
    const verificationUrl = current.vault.sealCloudflareSecret('https://dash.cloudflare.com/verify-email?token=private', {
      purpose: 'cloudflare-verification-url', id: signup.id,
    });
    current.cloudflareStore.markVerificationFound(signup.id, verificationUrl, new Date().toISOString());
    const verify = current.cloudflareStore.claimRunnerTask('runner-one', 60000);
    assert.equal(verify.status, 'verifying');
    current.cloudflareStore.markVerified(verify.id, 'runner-one', verify.lease_generation, 'a'.repeat(32));

    const raw = current.store.db.prepare(`
      SELECT status, browser_state_ciphertext, verification_url_ciphertext FROM cloudflare_job_items WHERE id=?
    `).get(verify.id);
    assert.deepEqual({ ...raw }, { status: 'verified', browser_state_ciphertext: null, verification_url_ciphertext: null });
    assert.equal(current.cloudflareStore.getJob(jobId).status, 'running');
    assert.equal(current.cloudflareStore.beginNextSignup().position, 2);
    assert.throws(
      () => current.cloudflareStore.createJob({ id: 'cfjob_duplicate', mailboxIds: ['mbx_1'], passwordMode: 'manual', passwordCiphertext }),
      (error) => error.statusCode === 409 && error.code === 'cloudflare_account_tracked',
    );
  } finally {
    current.close();
  }
});

test('Cloudflare restart recovery never blindly re-submits an uncertain visible form', () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_recovery';
    const ciphertext = current.vault.sealCloudflareSecret('Strong!Shared-Password-9988', {
      purpose: 'cloudflare-job-password', id: jobId,
    });
    const job = current.cloudflareStore.createJob({ id: jobId, mailboxIds: ['mbx_1'], passwordMode: 'manual', passwordCiphertext: ciphertext });
    current.cloudflareStore.beginNextSignup();
    const task = current.cloudflareStore.claimRunnerTask('runner-one', 60000);
    current.cloudflareStore.markAwaitingSubmit(task.id, 'runner-one', task.lease_generation);
    const summary = current.cloudflareStore.recoverInterruptedWork();
    assert.equal(summary.needsAction, 1);
    const recovered = current.cloudflareStore.getJob(job.id);
    assert.equal(recovered.status, 'needs_action');
    assert.equal(recovered.items[0].last_error_code, 'interrupted_submit_unknown');
    assert.throws(
      () => current.cloudflareStore.retryItem(task.id),
      (error) => error.statusCode === 409 && error.code === 'reconcile_required',
    );
    const queuedReconcile = current.cloudflareStore.reconcileItem(task.id);
    assert.equal(queuedReconcile.phase, 'reconciling');
    const reconcileSession = { id: 'runner-reconcile', revoked: false };
    const orchestrator = new CloudflareOrchestrator({
      cloudflareStore: current.cloudflareStore, store: current.store, vault: current.vault,
      mailClient: {}, runnerManager: {
        status: () => ({ online: true }), liveSession: () => reconcileSession,
      }, artifactStore: {},
      config: {
        cloudflareRunnerLeaseMs: 60000,
        cloudflareSignupUrl: 'https://dash.cloudflare.com/sign-up',
        cloudflareLoginUrl: 'https://dash.cloudflare.com/login',
      },
    });
    const reconcileTask = orchestrator.claimTask(reconcileSession);
    assert.equal(reconcileTask.kind, 'reconcile');
    assert.equal(reconcileTask.url, 'https://dash.cloudflare.com/login');

    const legacyId = 'cfjob_legacy_acceptance';
    const legacy = current.cloudflareStore.createJob({
      id: legacyId,
      mailboxIds: ['mbx_2'],
      passwordMode: 'manual',
      passwordCiphertext: current.vault.sealCloudflareSecret('Strong!Shared-Password-2277', {
        purpose: 'cloudflare-job-password', id: legacyId,
      }),
    });
    current.store.db.prepare(`
      UPDATE cloudflare_job_items SET status='waiting_for_verification', phase='waiting_for_verification',
        submitted_at=?, signup_acceptance_evidence=NULL WHERE id=?
    `).run(new Date().toISOString(), legacy.items[0].id);
    const legacyRecovery = current.cloudflareStore.recoverInterruptedWork();
    assert.equal(legacyRecovery.signupAcceptanceUnconfirmed, 1);
    const legacyItem = current.cloudflareStore.getItem(legacy.items[0].id);
    assert.equal(legacyItem.status, 'needs_action');
    assert.equal(legacyItem.last_error_code, 'signup_acceptance_unconfirmed');
    assert.throws(
      () => current.cloudflareStore.retryItem(legacyItem.id),
      (error) => error.code === 'reconcile_required',
    );
  } finally {
    current.close();
  }
});

test('Cloudflare safely reuses only a pre-submit cancelled mailbox workflow', () => {
  const current = fixture();
  try {
    const password = 'Strong!Shared-Password-5544';
    const create = (id, mailboxId) => current.cloudflareStore.createJob({
      id, mailboxIds: [mailboxId], passwordMode: 'manual',
      passwordCiphertext: current.vault.sealCloudflareSecret(password, { purpose: 'cloudflare-job-password', id }),
    });
    const safe = create('cfjob_cancel_safe', 'mbx_1');
    current.cloudflareStore.cancelJob(safe.id);
    assert.equal(current.cloudflareStore.eligibleMailboxMap(['mbx_1']).get('mbx_1').cloudflare_eligible, 1);
    const reused = create('cfjob_cancel_reused', 'mbx_1');
    assert.equal(reused.requested_count, 1);
    current.cloudflareStore.cancelJob(reused.id);

    const uncertain = create('cfjob_cancel_uncertain', 'mbx_2');
    current.cloudflareStore.beginNextSignup();
    const task = current.cloudflareStore.claimRunnerTask('runner-cancel', 60000);
    current.cloudflareStore.markSubmitted(task.id, 'runner-cancel', task.lease_generation);
    current.cloudflareStore.cancelJob(uncertain.id);
    assert.equal(current.cloudflareStore.eligibleMailboxMap(['mbx_2']).get('mbx_2').cloudflare_eligible, 0);
    assert.throws(
      () => create('cfjob_cancel_blocked', 'mbx_2'),
      (error) => error.statusCode === 409 && error.code === 'cloudflare_account_tracked',
    );
  } finally {
    current.close();
  }
});

test('Cloudflare browser errors cannot leak verification URLs into state or audit', () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_redaction';
    current.cloudflareStore.createJob({
      id: jobId, mailboxIds: ['mbx_1'], passwordMode: 'manual',
      passwordCiphertext: current.vault.sealCloudflareSecret('Strong!Shared-Password-9911', {
        purpose: 'cloudflare-job-password', id: jobId,
      }),
    });
    const item = current.cloudflareStore.beginNextSignup();
    const orchestrator = new CloudflareOrchestrator({
      cloudflareStore: current.cloudflareStore, store: current.store, vault: current.vault,
      mailClient: {}, runnerManager: {}, artifactStore: {}, config: {},
    });
    orchestrator.handleRunnerFailure(item, {
      code: 'browser_error', uncertain: true,
      message: 'page.goto failed at https://dash.cloudflare.com/verify-email?token=never-log-this',
    });
    const stored = JSON.stringify(current.cloudflareStore.getJob(jobId));
    const audit = JSON.stringify(current.store.recentAudit(100));
    assert.doesNotMatch(`${stored}\n${audit}`, /never-log-this|verify-email\?token/);
    assert.match(stored, /\[URL_REDACTED\]/);
  } finally {
    current.close();
  }
});

test('Cloudflare failure screenshots are encrypted, PNG-only and pruned after retention', () => {
  const current = fixture();
  try {
    const artifactDir = path.join(current.root, 'cloudflare-artifacts');
    const artifacts = new CloudflareArtifactStore({
      config: { cloudflareArtifactDir: artifactDir, cloudflareArtifactRetentionDays: 7 },
      vault: current.vault,
    });
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('private-pixels')]);
    const name = artifacts.save(`cfitem_${'a'.repeat(32)}`, 1, png.toString('base64'));
    const target = path.join(artifactDir, name);
    assert.deepEqual(artifacts.read(name), png);
    assert.equal(fs.readFileSync(target).includes(png), false);
    assert.throws(() => artifacts.save(`cfitem_${'b'.repeat(32)}`, 1, Buffer.from('not-png').toString('base64')));
    const expired = new Date(Date.now() - 8 * 86400000);
    fs.utimesSync(target, expired, expired);
    artifacts.nextPruneAt = 0;
    assert.equal(artifacts.pruneIfDue(), 1);
    assert.equal(fs.existsSync(target), false);
  } finally {
    current.close();
  }
});

test('Cloudflare verification selector rejects lookalike domains and mismatched messages', () => {
  assert.equal(isCloudflareVerificationUrl('https://dash.cloudflare.com/verify-email?token=ok'), true);
  assert.equal(isCloudflareVerificationUrl('http://dash.cloudflare.com/verify-email?token=no'), false);
  assert.equal(isCloudflareVerificationUrl('https://cloudflare.com.evil.example/verify'), false);
  assert.equal(isCloudflareVerificationUrl('https://evilcloudflare.com/verify'), false);
  assert.equal(isCloudflareSender('no-reply@cloudflare.com'), true);
  assert.equal(isCloudflareSender('no-reply@cloudflare.com.evil.example'), false);

  const submittedAt = '2026-08-27T10:00:00.000Z';
  const selected = selectCloudflareVerification([
    {
      id: 'fake', receivedAt: '2026-08-27T10:01:00.000Z', from: [{ email: 'no-reply@cloudflare.com.evil.example' }],
      to: [{ email: 'box@atomicmail.ai' }], subject: 'Verify your email', body: 'Verify',
      links: ['https://cloudflare.com.evil.example/verify?token=fake'],
    },
    {
      id: 'wrong-recipient', receivedAt: '2026-08-27T10:02:00.000Z', from: [{ email: 'no-reply@cloudflare.com' }],
      to: [{ email: 'other@atomicmail.ai' }], subject: 'Verify your email address', body: 'Confirm your email',
      links: ['https://dash.cloudflare.com/verify-email?token=wrong'],
    },
    {
      id: 'missing-recipient', receivedAt: '2026-08-27T10:02:30.000Z', from: [{ email: 'no-reply@cloudflare.com' }],
      to: [], subject: 'Verify your email address', body: 'Confirm your email',
      links: ['https://dash.cloudflare.com/verify-email?token=missing-recipient'],
    },
    {
      id: 'real', receivedAt: '2026-08-27T10:03:00.000Z', from: [{ email: 'no-reply@cloudflare.com' }],
      to: [{ email: 'box@atomicmail.ai' }], subject: 'Verify your email address', body: 'Confirm your email',
      links: ['https://dash.cloudflare.com/verify-email?token=private'],
    },
  ], { recipient: 'box@atomicmail.ai', submittedAt });
  assert.deepEqual(selected, {
    messageId: 'real', receivedAt: '2026-08-27T10:03:00.000Z',
    url: 'https://dash.cloudflare.com/verify-email?token=private',
  });
});

test('Cloudflare runner pairing is one-time, protocol-bound and rejects insecure remote transport', () => {
  const current = fixture();
  try {
    assert.equal(CLOUDFLARE_RUNNER_PROTOCOL, 2);
    const manager = new CloudflareRunnerManager({ config: current.config, store: current.store });
    const oldProtocol = manager.issuePairing();
    const localRequest = { socket: { remoteAddress: '127.0.0.1', encrypted: false }, headers: {} };
    assert.throws(
      () => manager.exchange(localRequest, { code: oldProtocol.code, protocolVersion: 1, name: 'Old runner' }),
      (error) => error.statusCode === 409 && error.code === 'runner_protocol_mismatch',
    );
    const pairing = manager.issuePairing();
    const paired = manager.exchange(localRequest, {
      code: pairing.code, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL, name: 'Test runner',
    });
    assert.equal(typeof paired.token, 'string');
    assert.equal(manager.status().online, true);
    const session = manager.authenticate({
      ...localRequest, headers: { authorization: `Bearer ${paired.token}` },
    });
    assert.equal(session.id, paired.runnerId);
    assert.throws(
      () => manager.exchange(localRequest, { code: pairing.code, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL, name: 'Replay' }),
      (error) => error.statusCode === 401,
    );
    const second = manager.issuePairing();
    assert.throws(
      () => manager.exchange({ socket: { remoteAddress: '203.0.113.20', encrypted: false }, headers: {} }, {
        code: second.code, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL, name: 'Remote',
      }),
      (error) => error.statusCode === 403 && error.code === 'runner_transport_insecure',
    );
    manager.revoke();
    assert.equal(manager.status().online, false);
    assert.throws(
      () => manager.authenticate({ ...localRequest, headers: { authorization: `Bearer ${paired.token}` } }),
      (error) => error.statusCode === 401 && error.code === 'runner_auth_invalid',
    );
    const reconnectCode = manager.issuePairing();
    const reconnected = manager.exchange(localRequest, {
      code: reconnectCode.code, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL, name: 'Reconnected runner',
    });
    assert.equal(manager.status().online, true);
    assert.notEqual(reconnected.token, paired.token);
    manager.revoke();
    current.config.cloudflarePairingTtlMs = -1;
    const expired = manager.issuePairing();
    assert.throws(
      () => manager.exchange(localRequest, {
        code: expired.code, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL, name: 'Expired',
      }),
      (error) => error.statusCode === 401 && error.code === 'runner_pair_invalid',
    );
  } finally {
    current.close();
  }
});

test('Cloudflare orchestrator completes signup, trusted inbox polling and profile verification with mock adapters', async () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_orchestrator';
    const ciphertext = current.vault.sealCloudflareSecret('Strong!Shared-Password-7788', {
      purpose: 'cloudflare-job-password', id: jobId,
    });
    current.cloudflareStore.createJob({ id: jobId, mailboxIds: ['mbx_1'], passwordMode: 'manual', passwordCiphertext: ciphertext });
    const session = { id: 'runner-mock' };
    const runnerManager = {
      liveSession: () => session,
      status: () => ({ online: true, runnerId: session.id }),
      requestCommand: () => true,
      heartbeat: () => ({ ok: true, commands: [] }),
    };
    let inboxChecks = 0;
    const mailClient = {
      async findCloudflareVerification(username, options) {
        inboxChecks += 1;
        assert.equal(username, 'mailboxuser1');
        assert.equal(options.recipient, 'mailboxuser1@atomicmail.ai');
        return {
          messageId: 'mail-cloudflare', receivedAt: new Date().toISOString(),
          url: 'https://dash.cloudflare.com/verify-email?token=secret',
        };
      },
    };
    const config = {
      cloudflareEnabled: true, cloudflareWorkerPollMs: 1000, cloudflareEmailPollMs: 15000,
      cloudflareVerificationTimeoutMs: 1200000, cloudflareRunnerLeaseMs: 60000,
      cloudflareMaxRetries: 3, cloudflareRetryBaseMs: 1000, cloudflareRetryMaxMs: 30000,
      cloudflareRateLimitCooldownMs: 900000, cloudflarePostItemDelayMs: 0,
      cloudflareSignupUrl: 'https://dash.cloudflare.com/sign-up', shutdownGraceMs: 1000,
    };
    const orchestrator = new CloudflareOrchestrator({
      cloudflareStore: current.cloudflareStore, store: current.store, vault: current.vault,
      mailClient, runnerManager, artifactStore: { save() { throw new Error('not expected'); } }, config,
    });
    await orchestrator.tick();
    const signup = orchestrator.claimTask(session);
    assert.equal(signup.kind, 'signup');
    assert.equal(signup.password, 'Strong!Shared-Password-7788');
    orchestrator.handleRunnerEvent(session, signup.id, signup.generation, {
      event: 'awaiting_submit', storageState: { cookies: [] },
    });
    assert.throws(
      () => orchestrator.handleRunnerEvent(session, signup.id, signup.generation, { event: 'submitted' }),
      (error) => error.statusCode === 400,
    );
    assert.equal(current.cloudflareStore.getItem(signup.id).status, 'awaiting_submit');
    orchestrator.handleRunnerEvent(session, signup.id, signup.generation, {
      event: 'needs_action', code: 'challenge', message: 'Complete the visible challenge', keepTaskOpen: true,
    });
    assert.equal(current.cloudflareStore.getJob(jobId).needs_action_count, 1);
    orchestrator.handleRunnerEvent(session, signup.id, signup.generation, {
      event: 'signup_accepted', evidence: 'verification_prompt_with_email',
      storageState: { cookies: [{ name: 'cf', value: 'private' }] },
    });
    const waiting = current.cloudflareStore.getJob(jobId);
    assert.equal(waiting.needs_action_count, 0);
    assert.equal(waiting.items[0].status, 'waiting_for_verification');
    assert.equal(waiting.items[0].signup_acceptance_evidence, 'verification_prompt_with_email');
    await orchestrator.tick();
    assert.equal(inboxChecks, 1);
    const verification = orchestrator.claimTask(session);
    assert.equal(verification.kind, 'verify');
    assert.match(verification.url, /^https:\/\/dash\.cloudflare\.com\/verify-email/);
    orchestrator.handleRunnerEvent(session, verification.id, verification.generation, {
      event: 'verified', cloudflareAccountId: 'b'.repeat(32),
    });
    const completed = current.cloudflareStore.getJob(jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verified_count, 1);
  } finally {
    current.close();
  }
});

test('Cloudflare verification polling stops with a recoverable action after its bounded window', async () => {
  const current = fixture();
  try {
    const jobId = 'cfjob_timeout';
    current.cloudflareStore.createJob({
      id: jobId,
      mailboxIds: ['mbx_1'],
      passwordMode: 'manual',
      passwordCiphertext: current.vault.sealCloudflareSecret('Strong!Shared-Password-3355', {
        purpose: 'cloudflare-job-password', id: jobId,
      }),
    });
    current.cloudflareStore.beginNextSignup();
    const task = current.cloudflareStore.claimRunnerTask('runner-timeout', 60000);
    current.cloudflareStore.markAwaitingSubmit(task.id, 'runner-timeout', task.lease_generation);
    current.cloudflareStore.markSubmitted(task.id, 'runner-timeout', task.lease_generation, null, {
      evidence: 'verification_prompt_after_operator_submit',
    });
    current.store.db.prepare(`
      UPDATE cloudflare_job_items SET verification_wait_started_at=?, next_attempt_at=? WHERE id=?
    `).run(new Date(Date.now() - 301000).toISOString(), new Date(0).toISOString(), task.id);
    let mailCalls = 0;
    const orchestrator = new CloudflareOrchestrator({
      cloudflareStore: current.cloudflareStore,
      store: current.store,
      vault: current.vault,
      mailClient: { async findCloudflareVerification() { mailCalls += 1; } },
      runnerManager: { status: () => ({ online: false }) },
      artifactStore: {},
      config: { cloudflareVerificationTimeoutMs: 300000, cloudflareEmailPollMs: 15000 },
    });
    await orchestrator.pollVerification(current.cloudflareStore.getItem(task.id));
    const timedOut = current.cloudflareStore.getJob(jobId);
    assert.equal(mailCalls, 0);
    assert.equal(timedOut.status, 'needs_action');
    assert.equal(timedOut.needs_action_count, 1);
    assert.equal(timedOut.items[0].last_error_code, 'verification_email_timeout');
    const retried = current.cloudflareStore.retryItem(task.id);
    assert.equal(retried.status, 'waiting_for_verification');
    assert.equal(current.cloudflareStore.getJob(jobId).needs_action_count, 0);
  } finally {
    current.close();
  }
});
