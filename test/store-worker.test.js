import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import { JobWorker } from '../src/worker.js';

function config(root) {
  return {
    workerEnabled: true,
    workerPollMs: 1000,
    postSuccessDelayMs: 0,
    maxRetries: 2,
    retryBaseMs: 1,
    retryMaxMs: 2,
    rateLimitCooldownMs: 10,
    transientCircuitThreshold: 5,
    transientCircuitCooldownMs: 10,
    usernameMinLength: 10,
    usernameMaxLength: 14,
    credentialsRoot: path.join(root, 'credentials'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
  };
}

function createVault(root) {
  const vault = new CredentialVault(config(root));
  vault.initialize();
  return vault;
}

test('worker creates sequential mailboxes and completes a job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const provider = {
    active: 0,
    maxActive: 0,
    async register(username) {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      this.active -= 1;
      return {
        username,
        email: `${username}@atomicmail.ai`,
        inboxId: `${username}@atomicmail.ai`,
        credentialsPath: path.join(root, 'credentials', username, 'credentials.json'),
      };
    },
  };

  const job = store.createJob({ count: 3, prefix: '', usernames: ['alpha11111', 'bravo22222', 'charlie3333'] });
  const vault = createVault(root);
  const worker = new JobWorker({ store, provider, config: config(root), vault });

  for (let i = 0; i < 10; i += 1) await worker.tick();

  const result = store.getJob(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.success_count, 3);
  assert.equal(store.countMailboxes(), 3);
  assert.equal(provider.maxActive, 1);
  const passwordRows = store.db.prepare(`
    SELECT id, account_password_ciphertext FROM mailboxes ORDER BY created_at, id
  `).all();
  const passwords = passwordRows.map((row) => vault.openMailboxPassword(row.account_password_ciphertext, row.id));
  assert.equal(new Set(passwords).size, 3);
  for (const password of passwords) {
    assert.equal(password.length, 20);
    assert.match(password, /^[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*_.+=?-]/);
  }
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('policy response opens permanent circuit and pauses job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const provider = {
    async register() {
      const error = new Error('blocked');
      error.kind = 'policy';
      error.raw = 'registration blocked by policy';
      throw error;
    },
  };
  const job = store.createJob({ count: 1, prefix: '', usernames: ['alpha11111'] });
  const worker = new JobWorker({ store, provider, config: config(root), vault: createVault(root) });
  await worker.tick();
  assert.equal(worker.circuitState().permanent, true);
  assert.equal(store.getJob(job.id).status, 'paused');
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('cancelled job is not overwritten as completed when an in-flight item succeeds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const job = store.createJob({ count: 1, prefix: '', usernames: ['cancel1111'] });
  const item = store.markItemRunning(job.items[0].id);
  store.setJobStatus(job.id, 'cancelled');
  store.markItemSucceeded(item.id, {
    username: item.username,
    email: `${item.username}@atomicmail.ai`,
    inboxId: `${item.username}@atomicmail.ai`,
    credentialsPath: path.join(root, 'credentials', item.username, 'credentials.json'),
  });
  assert.equal(store.getJob(job.id).status, 'cancelled');
  assert.equal(store.getJob(job.id).success_count, 1);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});


test('restart recovery returns interrupted work to pending without consuming a retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-recovery-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const job = store.createJob({ count: 2, prefix: '', usernames: ['recover1111', 'recover2222'] });

  const first = store.markItemRunning(job.items[0].id);
  store.markItemSucceeded(first.id, {
    username: first.username,
    email: `${first.username}@atomicmail.ai`,
    inboxId: `${first.username}@atomicmail.ai`,
    credentialsPath: path.join(root, 'credentials', first.username, 'credentials.json'),
  });

  const second = store.markItemRunning(job.items[1].id);
  assert.equal(second.attempts, 1);
  store.setJobStatus(job.id, 'paused');

  // Simulate stale counters from an interrupted process.
  store.db.prepare(`UPDATE jobs SET success_count=99, failed_count=77 WHERE id=?`).run(job.id);

  const summary = store.recoverInterruptedWork();
  const recovered = store.getJob(job.id);
  const recoveredSecond = recovered.items.find((item) => item.id === second.id);

  assert.equal(summary.interruptedItems, 1);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.success_count, 1);
  assert.equal(recovered.failed_count, 0);
  assert.equal(recoveredSecond.status, 'pending');
  assert.equal(recoveredSecond.attempts, 0);

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('restart recovery keeps cancelled jobs terminal and cancels in-flight items', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-recovery-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const job = store.createJob({ count: 1, prefix: '', usernames: ['cancel2222'] });
  const item = store.markItemRunning(job.items[0].id);
  store.setJobStatus(job.id, 'cancelled');

  const summary = store.recoverInterruptedWork();
  const recovered = store.getJob(job.id);

  assert.equal(summary.cancelledItems, 1);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.items[0].id, item.id);
  assert.equal(recovered.items[0].status, 'cancelled');

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('controlled worker shutdown aborts active registration and returns item to pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-shutdown-'));
  const store = new Store(path.join(root, 'db.sqlite'));

  let rejectRegistration;
  const provider = {
    abortActive() {
      const error = new Error('shutdown');
      error.kind = 'interrupted';
      error.raw = 'shutdown';
      rejectRegistration?.(error);
    },
    register() {
      return new Promise((_, reject) => {
        rejectRegistration = reject;
      });
    },
  };

  const job = store.createJob({ count: 1, prefix: '', usernames: ['stopper111'] });
  const worker = new JobWorker({ store, provider, config: { ...config(root), shutdownGraceMs: 1000 }, vault: createVault(root) });

  const tick = worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const idle = await worker.stop({ abortActive: true, waitMs: 1000 });
  await tick;

  const result = store.getJob(job.id);
  assert.equal(idle, true);
  assert.equal(result.status, 'running');
  assert.equal(result.items[0].status, 'pending');
  assert.equal(result.items[0].attempts, 0);

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});


test('controlled shutdown does not resurrect a cancelled in-flight item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-shutdown-'));
  const store = new Store(path.join(root, 'db.sqlite'));

  let rejectRegistration;
  const provider = {
    abortActive() {
      const error = new Error('shutdown');
      error.kind = 'interrupted';
      error.raw = 'shutdown';
      rejectRegistration?.(error);
    },
    register() {
      return new Promise((_, reject) => {
        rejectRegistration = reject;
      });
    },
  };

  const job = store.createJob({ count: 1, prefix: '', usernames: ['stopcancel1'] });
  const worker = new JobWorker({ store, provider, config: { ...config(root), shutdownGraceMs: 1000 }, vault: createVault(root) });

  const tick = worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.setJobStatus(job.id, 'cancelled');
  const idle = await worker.stop({ abortActive: true, waitMs: 1000 });
  await tick;

  const result = store.getJob(job.id);
  assert.equal(idle, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.items[0].status, 'cancelled');

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});


test('job item live phase, heartbeat and timing metadata persist safely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-progress-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const job = store.createJob({ count: 1, prefix: '', usernames: ['phase11111'] });
  const running = store.markItemRunning(job.items[0].id);
  assert.equal(running.phase, 'starting');
  assert.ok(running.attempt_started_at);

  store.updateItemProgress(running.id, 'proof_of_work', 'Solving Atomic Mail proof-of-work');
  let current = store.getJob(job.id);
  assert.equal(current.items[0].phase, 'proof_of_work');
  assert.match(current.items[0].phase_message, /proof-of-work/i);
  assert.ok(current.items[0].phase_updated_at);

  await new Promise((resolve) => setTimeout(resolve, 5));
  store.markItemSucceeded(running.id, {
    username: running.username,
    email: `${running.username}@atomicmail.ai`,
    inboxId: `${running.username}@atomicmail.ai`,
    credentialsPath: path.join(root, 'credentials', running.username, 'credentials.json'),
  });
  current = store.getJob(job.id);
  assert.equal(current.items[0].phase, 'completed');
  assert.ok(current.items[0].finished_at);
  assert.equal(current.timing.sample_count, 1);

  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});


test('existing pre-progress databases receive additive live-progress columns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-panel-migrate-'));
  const dbPath = path.join(root, 'db.sqlite');
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, requested_count INTEGER NOT NULL, prefix TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, last_error TEXT
    );
    CREATE TABLE job_items (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, position INTEGER NOT NULL,
      username TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
      mailbox_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(job_id, position), UNIQUE(job_id, username)
    );
    CREATE TABLE mailboxes (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, inbox_id TEXT NOT NULL,
      credentials_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
      job_id TEXT, job_item_id TEXT
    );
    INSERT INTO jobs(id, requested_count, prefix, status, created_at, updated_at)
    VALUES('job_legacy', 1, 'old', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  oldDb.close();

  const store = new Store(dbPath);
  const columns = new Set(store.db.prepare(`PRAGMA table_info(job_items)`).all().map((row) => row.name));
  for (const name of ['phase', 'phase_message', 'phase_updated_at', 'attempt_started_at', 'finished_at']) {
    assert.ok(columns.has(name), `missing migrated column ${name}`);
  }
  const jobColumns = new Set(store.db.prepare(`PRAGMA table_info(jobs)`).all().map((row) => row.name));
  assert.ok(jobColumns.has('destination_password_ciphertext'));
  const mailboxColumns = new Set(store.db.prepare(`PRAGMA table_info(mailboxes)`).all().map((row) => row.name));
  assert.ok(mailboxColumns.has('account_password_ciphertext'));
  assert.equal(store.getJob('job_legacy').prefix, 'old');
  assert.equal(store.getJob('job_legacy').has_destination_password, 0);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});
