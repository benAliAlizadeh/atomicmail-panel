import { randomInt } from 'node:crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CONSONANTS = 'bcdfghjklmnpqrstvwxyz';
const VOWELS = 'aeiou';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function pick(chars) {
  return chars[randomInt(0, chars.length)];
}

export function normalizePrefix(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
}

function randomReadableStem(length) {
  let out = pick(LETTERS);
  while (out.length < length) {
    out += out.length % 2 === 0 ? pick(VOWELS) : pick(CONSONANTS);
  }
  return out.slice(0, length);
}

export function generateUsername({ prefix = '', minLength = 10, maxLength = 14 } = {}) {
  if (minLength < 5 || maxLength > 21 || minLength > maxLength) {
    throw new Error('Atomic Mail usernames must remain within 5..21 characters');
  }

  const cleanPrefix = normalizePrefix(prefix);
  const targetLength = randomInt(minLength, maxLength + 1);
  const available = Math.max(1, targetLength - cleanPrefix.length);
  const stemLength = Math.max(1, available - 4);
  let candidate = `${cleanPrefix}${randomReadableStem(stemLength)}`;

  while (candidate.length < targetLength) candidate += pick(ALNUM);
  candidate = candidate.slice(0, Math.min(21, targetLength));

  while (candidate.length < 5) candidate += pick(ALNUM);
  return candidate;
}

export function generateUniqueUsernames(count, isTaken, options = {}) {
  const names = [];
  const local = new Set();
  const maxAttempts = Math.max(100, count * 30);
  let attempts = 0;

  while (names.length < count) {
    if (++attempts > maxAttempts) throw new Error('Could not generate enough unique usernames');
    const username = generateUsername(options);
    if (local.has(username) || isTaken(username)) continue;
    local.add(username);
    names.push(username);
  }
  return names;
}
