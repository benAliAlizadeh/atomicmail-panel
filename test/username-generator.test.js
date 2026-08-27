import test from 'node:test';
import assert from 'node:assert/strict';
import { generateUsername, generateUniqueUsernames, normalizePrefix } from '../src/username-generator.js';

test('normalizes prefixes safely', () => {
  assert.equal(normalizePrefix('My Test_+42'), 'mytest42');
});

test('generates Atomic Mail compatible usernames', () => {
  for (let i = 0; i < 200; i += 1) {
    const value = generateUsername({ prefix: 'ab', minLength: 10, maxLength: 14 });
    assert.match(value, /^[a-z0-9]{5,21}$/);
    assert.ok(value.length >= 10 && value.length <= 14);
    assert.ok(value.startsWith('ab'));
  }
});

test('generates unique names', () => {
  const values = generateUniqueUsernames(100, () => false, { minLength: 10, maxLength: 14 });
  assert.equal(new Set(values).size, 100);
});
