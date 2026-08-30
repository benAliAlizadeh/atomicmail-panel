import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUnsafeSourceArtifacts } from '../scripts/source-safety.js';

test('source safety catches legacy plaintext credential snapshots and secret files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-source-safety-'));
  try {
    fs.mkdirSync(path.join(root, 'data-before-am20'), { recursive: true });
    fs.mkdirSync(path.join(root, 'copied', 'credentials', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'copied', 'credentials', 'example', 'credentials.json'), '{}');
    fs.writeFileSync(path.join(root, 'copied', 'credentials', 'example', 'session.jwt'), 'jwt');
    fs.writeFileSync(path.join(root, 'copied', 'credentials', 'example', 'capability.jwt'), 'jwt');

    const unsafe = findUnsafeSourceArtifacts(root, { trackedFiles: [] });
    assert.deepEqual(unsafe, [
      'copied/credentials/example/capability.jwt',
      'copied/credentials/example/credentials.json',
      'copied/credentials/example/session.jwt',
      'data-before-am20',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source safety permits a local ignored .env by default but strict packaging mode blocks it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-source-safety-env-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=test\n');
    assert.deepEqual(findUnsafeSourceArtifacts(root, { trackedFiles: [] }), []);
    assert.deepEqual(findUnsafeSourceArtifacts(root, { trackedFiles: [], includeLocalEnv: true }), ['.env']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source safety permits examples, encrypted state, and dependency trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-source-safety-ok-'));
  try {
    fs.mkdirSync(path.join(root, 'data', 'credentials', 'example'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'example', 'credentials', 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env.example'), 'ADMIN_PASSWORD=change-me\n');
    fs.writeFileSync(path.join(root, 'data', 'credentials', 'example', 'credentials.json.enc'), 'encrypted');
    fs.writeFileSync(path.join(root, 'node_modules', 'example', 'credentials', 'test', 'credentials.json'), '{}');
    assert.deepEqual(findUnsafeSourceArtifacts(root, { trackedFiles: [] }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source safety catches supplied tracked .env and plaintext credential paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-source-safety-list-'));
  try {
    assert.deepEqual(findUnsafeSourceArtifacts(root, {
      trackedFiles: [
        '.env',
        'copied/credentials/example/credentials.json',
        '.env.example',
        'data/credentials/example/credentials.json.enc',
      ],
    }), ['.env', 'copied/credentials/example/credentials.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
