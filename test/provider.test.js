import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicMailProvider, classifyProviderError, resolveProviderInvocation } from '../src/provider.js';
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


test('provider reuses matching credentials after a crash instead of registering again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-provider-'));
  const username = 'reuse11111';
  const dir = path.join(root, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    inboxId: `${username}@atomicmail.ai`,
    apiKey: 'am_test_secret',
  }));

  const provider = new AtomicMailProvider({
    credentialsRoot: root,
    atomicAuthUrl: 'https://auth.atomicmail.ai',
    atomicApiUrl: 'https://api.atomicmail.ai',
    atomicWatchMode: 'on-demand',
    atomicCliCommand: 'this-command-must-not-run',
    atomicCliPrefixArgs: [],
    registerTimeoutMs: 30000,
  });

  const mailbox = await provider.register(username);
  assert.equal(mailbox.email, `${username}@atomicmail.ai`);
  assert.equal(mailbox.credentialsPath, path.join(dir, 'credentials.json'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('provider refuses to overwrite a credential directory for a different inbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-provider-'));
  const username = 'wanted1111';
  const dir = path.join(root, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    inboxId: 'different111@atomicmail.ai',
    apiKey: 'am_test_secret',
  }));

  const provider = new AtomicMailProvider({
    credentialsRoot: root,
    atomicAuthUrl: 'https://auth.atomicmail.ai',
    atomicApiUrl: 'https://api.atomicmail.ai',
    atomicWatchMode: 'on-demand',
    atomicCliCommand: 'this-command-must-not-run',
    atomicCliPrefixArgs: [],
    registerTimeoutMs: 30000,
  });

  await assert.rejects(
    provider.register(username),
    (error) => error?.kind === 'policy' && /does not match/i.test(error.message),
  );

  fs.rmSync(root, { recursive: true, force: true });
});


test('Windows npx invocation bypasses the .cmd shim and runs npx-cli.js with node.exe', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const expectedNpxCli = path.win32.join(
    path.win32.dirname(execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js',
  );

  const invocation = resolveProviderInvocation('npx', ['-y', 'atomicmail'], {
    platform: 'win32',
    execPath,
    existsSync: (candidate) => candidate === expectedNpxCli,
  });

  assert.equal(invocation.command, execPath);
  assert.deepEqual(invocation.args, [expectedNpxCli, '-y', 'atomicmail']);
});

test('Windows npx resolution fails clearly before contacting the provider when npm files are missing', () => {
  assert.throws(
    () => resolveProviderInvocation('npx', [], {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      existsSync: () => false,
    }),
    (error) => error?.kind === 'permanent' && /npx launcher was not found/i.test(error.message),
  );
});
