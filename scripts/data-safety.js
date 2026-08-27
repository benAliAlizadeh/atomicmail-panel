import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { CredentialVault } from '../src/credential-vault.js';
import { BackupManager } from '../src/backup-manager.js';
import { assertPanelStopped } from '../src/process-lock.js';

function usage() {
  console.log(`AtomicMail Panel data-safety CLI\n\nCommands:\n  status\n  create\n  verify [backup-file]\n  restore <backup-file>\n`);
}

const command = String(process.argv[2] || 'status').toLowerCase();
const arg = process.argv[3] || '';
const config = loadConfig();
const vault = new CredentialVault(config);
vault.initialize();

if (command === 'status') {
  const manager = new BackupManager({ config, vault });
  console.log(JSON.stringify({ vault: vault.status(), backups: manager.status() }, null, 2));
  process.exit(0);
}

if (command === 'verify') {
  const manager = new BackupManager({ config, vault });
  const name = arg || manager.latestBackup()?.name;
  if (!name) throw new Error('No backup exists to verify');
  console.log(JSON.stringify(manager.verifyBackup(name), null, 2));
  process.exit(0);
}

if (command === 'create') {
  const store = new Store(config.dbPath);
  try {
    const manager = new BackupManager({ config, store, vault });
    const result = await manager.createBackup('cli-manual');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
  process.exit(0);
}

if (command === 'restore') {
  if (!arg) {
    usage();
    throw new Error('restore requires a backup filename/path');
  }
  assertPanelStopped(config.pidPath);

  // Create a verified encrypted safety backup of the current installation
  // before replacing anything. If the current DB is too damaged to open, the
  // requested restore still remains available and no source backup is touched.
  try {
    const currentStore = new Store(config.dbPath);
    try {
      const currentManager = new BackupManager({ config, store: currentStore, vault });
      const pre = await currentManager.createBackup('pre-restore');
      console.log(`Pre-restore safety backup: ${pre.name}`);
    } finally {
      currentStore.close();
    }
  } catch (error) {
    console.warn(`Could not create pre-restore safety backup: ${error?.message || error}`);
  }

  const manager = new BackupManager({ config, vault });
  const target = path.isAbsolute(arg) ? arg : arg;
  const result = manager.restoreBackup(target);

  // Absolute credential paths in old DB snapshots are intentionally rebased to
  // the current machine so backups remain portable across Windows/Linux/hosts.
  const restoredStore = new Store(config.dbPath);
  try {
    const changed = restoredStore.rebaseCredentialPaths(config.credentialsRoot);
    restoredStore.checkpoint();
    console.log(JSON.stringify({ ...result, rebasedCredentialPaths: changed }, null, 2));
  } finally {
    restoredStore.close();
  }
  process.exit(0);
}

usage();
process.exitCode = 2;
