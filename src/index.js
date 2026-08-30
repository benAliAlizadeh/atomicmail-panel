import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { CredentialVault } from './credential-vault.js';
import { BackupManager } from './backup-manager.js';
import { AtomicMailProvider } from './provider.js';
import { AtomicMailJmapClient } from './jmap-client.js';
import { JobWorker } from './worker.js';
import { CloudflareManualService } from './cloudflare-manual-service.js';
import { createServer } from './server.js';
import { acquirePidLock } from './process-lock.js';
import { hardenStoragePaths } from './file-security.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const releasePidLock = acquirePidLock(config.pidPath);

const store = new Store(config.dbPath);
const vault = new CredentialVault(config);
const vaultStatus = vault.initialize();
const permissionStatus = hardenStoragePaths(config);
vault.permissionStatus = permissionStatus;
const legacyMigration = vault.migrateLegacyCredentials();
const runtimeRecovery = vault.recoverRuntimeDirectories();
const rebasedCredentialPaths = store.rebaseCredentialPaths(config.credentialsRoot);

if (legacyMigration.migratedMailboxes || runtimeRecovery.recovered || rebasedCredentialPaths) {
  store.audit(
    'info',
    'data_safety.migrated',
    `Encrypted ${legacyMigration.encryptedFiles} legacy credential file(s), recovered ${runtimeRecovery.recovered} runtime credential directorie(s), rebased ${rebasedCredentialPaths} mailbox path(s)`,
  );
}

const backupManager = new BackupManager({ config, store, vault });
const provider = new AtomicMailProvider(config, vault);
const mailClient = new AtomicMailJmapClient(config, vault);
const worker = new JobWorker({ store, provider, config, backupManager, vault });
const cloudflareManualService = new CloudflareManualService({
  store,
  vault,
  mailClient,
  config,
  backupManager,
});
const cloudflareMigration = cloudflareManualService.initialize();
if (cloudflareMigration.migrated) {
  console.log(`Cloudflare manual assistant: migrated ${cloudflareMigration.migrated} existing account record(s)`);
}
const server = createServer({
  store,
  worker,
  config,
  backupManager,
  vault,
  mailClient,
  cloudflareManualService,
});

worker.start();
backupManager.start();
if (store.hasBackupData()) backupManager.requestBackup('startup-protection');

server.listen(config.port, config.host, () => {
  console.log(`AtomicMail Panel listening on http://${config.host}:${config.port}`);
  console.log(`Worker: ${config.workerEnabled ? 'enabled (concurrency=1)' : 'disabled'}`);
  console.log(`Cloudflare manual assistant: ${config.cloudflareEnabled ? 'enabled (no browser runner)' : 'disabled'}`);
  console.log(`Admin auth: ${config.adminPassword ? 'enabled' : 'disabled'}`);
  console.log(`Atomic Mail watch mode: ${config.atomicWatchMode}`);
  console.log(`Credential vault: ${vaultStatus.encryption}; key fingerprint ${vaultStatus.keyFingerprint}`);
  console.log(`Encryption key source: ${vaultStatus.keySource}`);
  console.log(`Storage permissions: ${permissionStatus.hardened ? 'hardened' : `WARNING - ${permissionStatus.warning}`}`);
  console.log(`Encrypted backups: ${config.autoBackupEnabled ? `enabled every ${Math.round(config.autoBackupIntervalMs / 60000)} minute(s)` : 'disabled'}`);
  if (vaultStatus.keySource === 'external-key-file') {
    console.log(`IMPORTANT: back up ${config.encryptionKeyPath} separately. Losing this key means encrypted credentials/backups cannot be recovered.`);
  }
  if (!config.adminPassword) console.log('Security note: keep the panel bound to localhost/private access while ADMIN_PASSWORD is empty.');
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);

  const hardExit = setTimeout(() => {
    console.error('Shutdown grace period exceeded; exiting so restart recovery can safely resume pending work.');
    releasePidLock();
    process.exit(1);
  }, config.shutdownGraceMs + 20000);
  hardExit.unref();

  const serverClosed = new Promise((resolve) => {
    server.close(() => resolve());
  });

  const idle = await worker.stop({ abortActive: true, waitMs: config.shutdownGraceMs });
  if (!idle) {
    console.error('The Atomic Mail worker did not become idle before shutdown deadline.');
    return;
  }

  await serverClosed;
  try {
    await backupManager.stop({ finalBackup: true });
  } catch (error) {
    console.warn(`Final encrypted backup warning: ${error?.message || error}`);
  }
  try {
    store.checkpoint();
  } catch (error) {
    console.warn(`SQLite checkpoint warning: ${error?.message || error}`);
  }
  store.close();
  releasePidLock();
  clearTimeout(hardExit);
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
