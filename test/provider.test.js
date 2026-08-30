import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicMailProvider, classifyProviderError, resolveProviderInvocation } from '../src/provider.js';
import { CredentialVault } from '../src/credential-vault.js';
import { redactSecrets, retryDelay } from '../src/utils.js';


function makeVault(root) {
  const config = {
    credentialsRoot: path.join(root, 'credentials'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
  };
  const vault = new CredentialVault(config);
  vault.initialize();
  return { vault, config };
}

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
  const raw = 'apiKey am_abcdefghijklmnop cfk_TEST_secret_abcdefghijklmnop cfat_TEST_token_abcdefghijklmnop token eyJabc.def.ghi Authorization: Bearer abc123';
  const safe = redactSecrets(raw);
  assert.ok(!safe.includes('am_abcdefghijklmnop'));
  assert.ok(!safe.includes('cfk_TEST_secret_abcdefghijklmnop'));
  assert.ok(!safe.includes('cfat_TEST_token_abcdefghijklmnop'));
  assert.ok(!safe.includes('eyJabc.def.ghi'));
  assert.ok(!safe.includes('abc123'));
});

test('retry delay remains capped with jitter', () => {
  for (let i = 0; i < 30; i += 1) {
    const delay = retryDelay(10, 1000, 10000);
    assert.ok(delay >= 8000 && delay <= 12000);
  }
});


test('provider reuses matching encrypted credentials after a crash instead of registering again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-provider-'));
  const username = 'reuse11111';
  const { vault, config: vaultConfig } = makeVault(root);
  const dir = path.join(vaultConfig.credentialsRoot, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    inboxId: username,
    apiKey: 'am_test_secret',
  }));
  vault.migrateLegacyCredentials();
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json.enc')), true);

  const provider = new AtomicMailProvider({
    ...vaultConfig,
    atomicAuthUrl: 'https://auth.atomicmail.ai',
    atomicApiUrl: 'https://api.atomicmail.ai',
    atomicWatchMode: 'on-demand',
    atomicCliCommand: 'this-command-must-not-run',
    atomicCliPrefixArgs: [],
    registerTimeoutMs: 30000,
  }, vault);

  const mailbox = await provider.register(username);
  assert.equal(mailbox.email, `${username}@atomicmail.ai`);
  assert.equal(mailbox.inboxId, username);
  assert.equal(mailbox.credentialsPath, path.join(dir, 'credentials.json.enc'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('provider refuses mismatched encrypted credentials for another inbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-provider-'));
  const username = 'wanted1111';
  const { vault, config: vaultConfig } = makeVault(root);
  const dir = path.join(vaultConfig.credentialsRoot, username);
  fs.mkdirSync(dir, { recursive: true });
  // Encrypt a syntactically valid credential file under the requested vault
  // path but with a different inboxId to prove the provider refuses it.
  vault.writeEncryptedFile(username, 'credentials.json', Buffer.from(JSON.stringify({
    inboxId: 'different111@atomicmail.ai',
    apiKey: 'am_test_secret',
  })));

  const provider = new AtomicMailProvider({
    ...vaultConfig,
    atomicAuthUrl: 'https://auth.atomicmail.ai',
    atomicApiUrl: 'https://api.atomicmail.ai',
    atomicWatchMode: 'on-demand',
    atomicCliCommand: 'this-command-must-not-run',
    atomicCliPrefixArgs: [],
    registerTimeoutMs: 30000,
  }, vault);

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


test('provider reports operator-safe progress when reusing encrypted crash-safe credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-provider-progress-'));
  const username = 'progress111';
  const { vault, config: vaultConfig } = makeVault(root);
  vault.writeEncryptedFile(username, 'credentials.json', Buffer.from(JSON.stringify({
    inboxId: username,
    apiKey: 'am_test_secret',
  })));
  const events = [];
  const provider = new AtomicMailProvider({
    ...vaultConfig,
    atomicAuthUrl: 'https://auth.atomicmail.ai',
    atomicApiUrl: 'https://api.atomicmail.ai',
    atomicWatchMode: 'on-demand',
    atomicCliCommand: 'must-not-run',
    atomicCliPrefixArgs: [],
    registerTimeoutMs: 30000,
  }, vault);
  await provider.register(username, { onProgress: (event) => events.push(event) });
  assert.equal(events[0].phase, 'preparing');
  assert.ok(events.some((event) => event.phase === 'recovered'));
  assert.ok(events.every((event) => !String(event.message).includes('am_test_secret')));
  fs.rmSync(root, { recursive: true, force: true });
});
