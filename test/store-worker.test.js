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
