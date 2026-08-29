import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialVault } from '../src/credential-vault.js';
import { BackupManager } from '../src/backup-manager.js';
import { Store } from '../src/db.js';
import { CloudflareManualService } from '../src/cloudflare-manual-service.js';

function makeConfig(root) {
  const dataDir = path.join(root, 'data');
  return {
    dataDir,
    dbPath: path.join(dataDir, 'atomicmail-panel.sqlite'),
    credentialsRoot: path.join(dataDir, 'credentials'),
    runtimeCredentialsRoot: path.join(root, 'runtime'),
    secretsDir: path.join(root, 'secrets'),
    encryptionKeyPath: path.join(root, 'secrets', 'data.key'),
    backupDir: path.join(root, 'backups'),
    backupRetention: 5,
    autoBackupEnabled: true,
    autoBackupIntervalMs: 3600000,
    backupMinGapMs: 60000,
  };
}

function createMailbox(store, vault, username, destinationPassword = '') {
  vault.writeEncryptedFile(username, 'credentials.json', Buffer.from(JSON.stringify({
    inboxId: `${username}@atomicmail.ai`,
    apiKey: `secret-${username}`,
  })));
  const jobId = `job_test_${username}`;
  const destinationPasswordCiphertext = destinationPassword ? vault.sealJobPassword(destinationPassword, jobId) : null;
  const job = store.createJob({
    id: jobId,
    count: 1,
    prefix: '',
    usernames: [username],
    destinationPasswordCiphertext,
  });
  const item = store.markItemRunning(job.items[0].id);
  store.markItemSucceeded(item.id, {
    username,
    email: `${username}@atomicmail.ai`,
    inboxId: `${username}@atomicmail.ai`,
    credentialsPath: vault.credentialsPath(username),
  });
}

test('legacy plaintext credentials are authenticated, encrypted, and removed from permanent storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-vault-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    const status = vault.initialize();
    const username = 'secure11111';
    const dir = path.join(config.credentialsRoot, username);
    fs.mkdirSync(dir, { recursive: true });
    const plainPath = path.join(dir, 'credentials.json');
    fs.writeFileSync(plainPath, JSON.stringify({ inboxId: `${username}@atomicmail.ai`, apiKey: 'top-secret-api-key' }));

    const migrated = vault.migrateLegacyCredentials();
    assert.equal(migrated.migratedMailboxes, 1);
    assert.equal(fs.existsSync(plainPath), false);
    assert.equal(fs.existsSync(`${plainPath}.enc`), true);
    assert.equal(vault.readCredentials(username).apiKey, 'top-secret-api-key');
    assert.equal(vault.status().plaintextCredentialFiles, 0);
    assert.equal(status.keySource, 'external-key-file');
    assert.ok(fs.existsSync(config.encryptionKeyPath));
    assert.equal(config.encryptionKeyPath.startsWith(config.dataDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('real AgentSkill local inboxId format migrates safely and resolves to an Atomic Mail address', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-vault-local-inbox-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    vault.initialize();
    const username = 'localid1111';
    const dir = path.join(config.credentialsRoot, username);
    fs.mkdirSync(dir, { recursive: true });
    const plainPath = path.join(dir, 'credentials.json');
    fs.writeFileSync(plainPath, JSON.stringify({ inboxId: username, apiKey: 'real-shape-secret' }));

    const migrated = vault.migrateLegacyCredentials();
    assert.equal(migrated.migratedMailboxes, 1);
    assert.equal(fs.existsSync(plainPath), false);
    assert.equal(vault.validateCredentials(username, vault.readCredentials(username)), true);
    assert.deepEqual(vault.credentialIdentity(username, vault.readCredentials(username)), {
      inboxId: username,
      email: `${username}@atomicmail.ai`,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wrong encryption key cannot decrypt credential vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-vault-key-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    vault.initialize();
    const username = 'wrongkey111';
    vault.writeEncryptedFile(username, 'credentials.json', Buffer.from(JSON.stringify({
      inboxId: `${username}@atomicmail.ai`, apiKey: 'secret',
    })));

    fs.writeFileSync(config.encryptionKeyPath, `${Buffer.alloc(32, 7).toString('base64')}\n`);
    const wrongVault = new CredentialVault(config);
    wrongVault.initialize();
    assert.throws(() => wrongVault.readCredentials(username), /wrong|corrupted|authenticated/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart recovery reseals credentials left in a Webmail runtime and discards orphan attachment workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-webmail-restart-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    vault.initialize();
    const username = 'restart1111';
    vault.writeEncryptedFile(username, 'credentials.json', Buffer.from(JSON.stringify({
      inboxId: username, apiKey: 'restart-secret',
    })));
    const runtime = vault.materialize(username);
    fs.writeFileSync(path.join(runtime, 'session.jwt'), 'refreshed-session-token');
    const orphanAttachmentDir = path.join(config.runtimeCredentialsRoot, 'mail-attachments-orphan');
    fs.mkdirSync(orphanAttachmentDir, { recursive: true });
    fs.writeFileSync(path.join(orphanAttachmentDir, 'private.txt'), 'temporary attachment');

    const restartedVault = new CredentialVault(config);
    restartedVault.initialize();
    const recovery = restartedVault.recoverRuntimeDirectories();
    assert.deepEqual(recovery, { recovered: 1, discarded: 1 });
    assert.equal(fs.existsSync(runtime), false);
    assert.equal(fs.existsSync(orphanAttachmentDir), false);
    assert.equal(restartedVault.readCredentials(username).apiKey, 'restart-secret');
    assert.equal(restartedVault.readEncryptedFile(username, 'session.jwt').toString('utf8'), 'refreshed-session-token');
    assert.equal(restartedVault.status().plaintextCredentialFiles, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('encrypted backup verifies and restores portably onto a different path', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-backup-src-'));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-backup-dst-'));
  try {
    const sourceConfig = makeConfig(sourceRoot);
    const sourceVault = new CredentialVault(sourceConfig);
    sourceVault.initialize();
    const sourceStore = new Store(sourceConfig.dbPath);
    createMailbox(sourceStore, sourceVault, 'portable1111', 'destination-secret-4477');
    const mailboxId = sourceStore.listMailboxes(1)[0].id;
    const sourceCloudflare = new CloudflareManualService({
      store: sourceStore, vault: sourceVault, config: { cloudflareMaxBatchSize: 100, exportMaxRows: 1000 },
    });
    sourceCloudflare.createBatch([mailboxId]);
    const sourceCloudflareAccount = sourceCloudflare.getFocusAccount().account;
    const sourceCloudflarePassword = sourceCloudflare.revealPassword(sourceCloudflareAccount.id);
    sourceCloudflare.updateNotes(sourceCloudflareAccount.id, 'Resume this account after portable restore');
    sourceCloudflare.markSignupDone(sourceCloudflareAccount.id);
    const manager = new BackupManager({ config: sourceConfig, store: sourceStore, vault: sourceVault });
    const backup = await manager.createBackup('test');
    assert.equal(backup.verified, true);
    assert.equal(backup.credentialFiles, 1);
    sourceStore.close();

    const targetConfig = makeConfig(targetRoot);
    fs.mkdirSync(path.dirname(targetConfig.encryptionKeyPath), { recursive: true });
    fs.copyFileSync(sourceConfig.encryptionKeyPath, targetConfig.encryptionKeyPath);
    fs.mkdirSync(targetConfig.backupDir, { recursive: true });
    const sourceBackup = path.join(sourceConfig.backupDir, backup.name);
    const targetBackup = path.join(targetConfig.backupDir, backup.name);
    fs.copyFileSync(sourceBackup, targetBackup);

    const targetVault = new CredentialVault(targetConfig);
    targetVault.initialize();
    const targetManager = new BackupManager({ config: targetConfig, vault: targetVault });
    assert.equal(targetManager.verifyBackup(backup.name).verified, true);
    targetManager.restoreBackup(backup.name);

    const targetStore = new Store(targetConfig.dbPath);
    const changed = targetStore.rebaseCredentialPaths(targetConfig.credentialsRoot);
    assert.equal(changed, 1);
    assert.equal(targetStore.countMailboxes(), 1);
    const mailbox = targetStore.listMailboxes(1)[0];
    assert.equal(mailbox.email, 'portable1111@atomicmail.ai');
    const restoredPassword = targetStore.getJobPasswordCiphertext('job_test_portable1111');
    assert.equal(
      targetVault.openJobPassword(restoredPassword.destination_password_ciphertext, restoredPassword.id),
      'destination-secret-4477',
    );
    assert.equal(targetVault.readCredentials('portable1111').apiKey, 'secret-portable1111');
    const restoredCloudflare = new CloudflareManualService({
      store: targetStore, vault: targetVault, config: { cloudflareMaxBatchSize: 100, exportMaxRows: 1000 },
    });
    assert.equal(restoredCloudflare.initialize().migrated, 0);
    const restoredCloudflareAccount = restoredCloudflare.getFocusAccount().account;
    assert.equal(restoredCloudflareAccount.id, sourceCloudflareAccount.id);
    assert.equal(restoredCloudflareAccount.status, 'signup_done');
    assert.equal(restoredCloudflareAccount.notes, 'Resume this account after portable restore');
    assert.equal(restoredCloudflare.revealPassword(restoredCloudflareAccount.id), sourceCloudflarePassword);
    assert.equal(targetVault.status().plaintextCredentialFiles, 0);
    targetStore.close();
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('tampered encrypted backup is rejected before restore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-backup-tamper-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    vault.initialize();
    const store = new Store(config.dbPath);
    createMailbox(store, vault, 'tamper11111');
    const manager = new BackupManager({ config, store, vault });
    const backup = await manager.createBackup('test');
    const file = path.join(config.backupDir, backup.name);
    const bytes = fs.readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    fs.writeFileSync(file, bytes);
    assert.throws(() => manager.verifyBackup(backup.name), /authenticated|corrupted|invalid/i);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown backup protects a destination-password job even before its first mailbox exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicmail-password-only-backup-'));
  try {
    const config = makeConfig(root);
    const vault = new CredentialVault(config);
    vault.initialize();
    const store = new Store(config.dbPath);
    const jobId = 'job_password_only';
    store.createJob({
      id: jobId,
      count: 1,
      prefix: '',
      usernames: ['password111'],
      destinationPasswordCiphertext: vault.sealJobPassword('not-yet-used-8822', jobId),
    });
    assert.equal(store.countMailboxes(), 0);
    assert.equal(store.hasBackupData(), true);
    const manager = new BackupManager({ config, store, vault });
    const backup = await manager.stop({ finalBackup: true });
    assert.equal(backup.verified, true);
    assert.equal(manager.verifyBackup(backup.name).verified, true);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
