import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError } from '../src/provider.js';
import { redactSecrets, retryDelay } from '../src/utils.js';

test('classifies rate limiting', () => {
  const value = classifyProviderError('HTTP 429 Too Many Requests Retry-After: 120');
  assert.equal(value.kind, 'rate_limited');
  assert.equal(value.retryAfterMs, 120000);
});

test('classifies username conflicts', () => {
  assert.equal(classifyProviderError('username already taken').kind, 'username_conflict');
});

test('classifies policy/abuse protection', () => {
  assert.equal(classifyProviderError('registration blocked by abuse policy').kind, 'policy');
});

test('redacts API keys and JWTs', () => {
  const raw = 'apiKey am_abcdefghijklmnop token eyJabc.def.ghi Authorization: Bearer abc123';
  const safe = redactSecrets(raw);
  assert.ok(!safe.includes('am_abcdefghijklmnop'));
  assert.ok(!safe.includes('eyJabc.def.ghi'));
  assert.ok(!safe.includes('abc123'));
});

test('retry delay remains capped with jitter', () => {
  for (let i = 0; i < 30; i += 1) {
    const delay = retryDelay(10, 1000, 10000);
    assert.ok(delay >= 8000 && delay <= 12000);
  }
});
