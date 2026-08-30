import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeLegacyPlaintext } from '../scripts/purge-legacy-plaintext.js';

test('legacy plaintext purge requires an exact confirmation and deletes only the legacy snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-purge-legacy-'));
  try {
    const legacy = path.join(root, 'data-before-am20');
    const data = path.join(root, 'data');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'credentials.json'), 'secret');
    fs.writeFileSync(path.join(data, 'keep.txt'), 'keep');

    assert.throws(
      () => purgeLegacyPlaintext(root),
      (error) => error.code === 'confirmation_required',
    );
    assert.equal(fs.existsSync(legacy), true);

    const result = purgeLegacyPlaintext(root, { confirmation: 'DELETE LEGACY PLAINTEXT' });
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy plaintext purge is idempotent when the snapshot is already absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-purge-legacy-empty-'));
  try {
    assert.deepEqual(
      purgeLegacyPlaintext(root, { confirmation: 'DELETE LEGACY PLAINTEXT' }),
      { removed: false, target: path.join(root, 'data-before-am20') },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
