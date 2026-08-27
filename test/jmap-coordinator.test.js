import test from 'node:test';
import assert from 'node:assert/strict';
import { JmapRequestCoordinator, parseRetryAfter, rateLimitDetails } from '../src/jmap-coordinator.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Retry-After parsing recognizes provider JSON/error text', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('Retry after 2s'), 2000);
  assert.equal(rateLimitDetails(new Error('JMAP session fetch failed (HTTP 429): rate_limited. Retry after 3s.')).retryAfterMs, 3000);
});

test('global JMAP coordinator serializes mailboxes and prioritizes interactive webmail', async () => {
  const gate = deferred();
  const started = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = new JmapRequestCoordinator({
    executor: async (mailbox, operation) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(operation.name);
      if (operation.name === 'first') await gate.promise;
      active -= 1;
      return mailbox;
    },
    minIntervalMs: 0,
  });
  const first = coordinator.schedule('box-a', { name: 'first' });
  const background = coordinator.schedule('box-b', { name: 'verification' }, { priority: 'background' });
  const interactive = coordinator.schedule('box-a', { name: 'webmail' }, { priority: 'interactive' });
  gate.resolve();
  await Promise.all([first, background, interactive]);
  assert.equal(maxActive, 1);
  assert.deepEqual(started, ['first', 'webmail', 'verification']);
});

test('background verification requests coalesce and 429 retries honor the shared limiter', async () => {
  let calls = 0;
  const coordinator = new JmapRequestCoordinator({
    executor: async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('HTTP 429 rate_limited Retry after 0.01s'), { statusCode: 429 });
      }
      return { ok: true };
    },
    maxRetries: 2,
    baseDelayMs: 10,
    maxDelayMs: 20,
    minIntervalMs: 0,
    random: () => 0,
  });
  const first = coordinator.schedule('box-a', { name: 'verification' }, {
    priority: 'background', coalesceKey: 'verification:submitted-at',
  });
  const second = coordinator.schedule('box-a', { name: 'verification' }, {
    priority: 'background', coalesceKey: 'verification:submitted-at',
  });
  assert.equal(first, second);
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 2);
});

test('exhausted JMAP 429s surface a friendly temporary response with retry timing', async () => {
  const coordinator = new JmapRequestCoordinator({
    executor: async () => {
      throw Object.assign(new Error('HTTP 429 rate_limited Retry after 0.01s'), { statusCode: 429 });
    },
    maxRetries: 0,
    baseDelayMs: 10,
    maxDelayMs: 10,
    minIntervalMs: 0,
    random: () => 0,
  });
  await assert.rejects(
    () => coordinator.schedule('box-a', {}, { priority: 'interactive' }),
    (error) => error.code === 'mail_rate_limited'
      && error.statusCode === 429
      && error.retryAfterMs > 0
      && /Retrying automatically/.test(error.message),
  );
});
