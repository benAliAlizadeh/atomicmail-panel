import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
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
  };
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
  const worker = new JobWorker({ store, provider, config: config(root) });

  for (let i = 0; i < 10; i += 1) await worker.tick();

  const result = store.getJob(job.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.success_count, 3);
  assert.equal(store.countMailboxes(), 3);
  assert.equal(provider.maxActive, 1);
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
  const worker = new JobWorker({ store, provider, config: config(root) });
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
  const worker = new JobWorker({ store, provider, config: { ...config(root), shutdownGraceMs: 1000 } });

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
  const worker = new JobWorker({ store, provider, config: { ...config(root), shutdownGraceMs: 1000 } });

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
