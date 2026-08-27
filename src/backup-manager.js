import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const BACKUP_FORMAT = 'atomicmail-panel-encrypted-backup';
const BACKUP_VERSION = 1;

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch {}
}

function chmodQuiet(target, mode) {
  try { fs.chmodSync(target, mode); } catch {}
}

function safeBackupName(name) {
  const value = path.basename(String(name || ''));
  if (!/^atomicmail-backup-[0-9TZ.-]+-[a-f0-9]{8}\.ambak$/i.test(value)) throw new Error('Invalid backup filename');
  return value;
}

function walkFiles(root, relative = '') {
  if (!fs.existsSync(root)) return [];
  const dir = path.join(root, relative);
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    const full = path.join(root, rel);
    if (entry.isDirectory()) rows.push(...walkFiles(root, rel));
    else if (entry.isFile()) rows.push({ relative: rel, full });
  }
  return rows;
}

function atomicWrite(filePath, data) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  chmodQuiet(temp, 0o600);
  fs.renameSync(temp, filePath);
  chmodQuiet(filePath, 0o600);
}

function validateDatabaseBuffer(buffer, tempRoot) {
  ensureDir(tempRoot);
  const file = path.join(tempRoot, `verify-${process.pid}-${crypto.randomBytes(5).toString('hex')}.sqlite`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    const result = row ? Object.values(row)[0] : null;
    if (String(result).toLowerCase() !== 'ok') throw new Error(`SQLite integrity_check failed: ${result}`);
    const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((item) => item.name));
    for (const required of ['jobs', 'job_items', 'mailboxes', 'system_state', 'audit_logs']) {
      if (!tables.has(required)) throw new Error(`Backup database is missing required table ${required}`);
    }
  } finally {
    try { db?.close(); } catch {}
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

export class BackupManager {
  constructor({ config, store = null, vault }) {
    this.config = config;
    this.store = store;
    this.vault = vault;
    this.interval = null;
    this.pendingTimer = null;
    this.busyPromise = null;
    this.lastBackupAtMs = 0;
    ensureDir(this.config.backupDir);
  }

  backupPath(name) {
    return path.join(this.config.backupDir, safeBackupName(name));
  }

  listBackups(limit = 20) {
    ensureDir(this.config.backupDir);
    return fs.readdirSync(this.config.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ambak'))
      .map((entry) => {
        const full = path.join(this.config.backupDir, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  latestBackup() {
    return this.listBackups(1)[0] || null;
  }

  async createBackup(reason = 'manual') {
    if (!this.store) throw new Error('Database store is required to create a backup');
    if (this.busyPromise) return this.busyPromise;
    this.busyPromise = Promise.resolve().then(() => this.#createBackup(reason));
    try { return await this.busyPromise; } finally { this.busyPromise = null; }
  }

  #createBackup(reason) {
    ensureDir(this.config.backupDir);
    const tempRoot = path.join(this.config.dataDir, '.backup-runtime');
    ensureDir(tempRoot);
    const dbSnapshot = path.join(tempRoot, `snapshot-${process.pid}-${crypto.randomBytes(5).toString('hex')}.sqlite`);
    try {
      this.store.createSnapshot(dbSnapshot);
      const credentialFiles = this.vault.listEncryptedFiles().map((file) => ({
        path: file.relative.replaceAll('\\', '/'),
        data: fs.readFileSync(file.full).toString('base64'),
      }));
      const payload = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        reason: String(reason || 'manual').slice(0, 80),
        keyFingerprint: this.vault.keyFingerprint,
        database: fs.readFileSync(dbSnapshot).toString('base64'),
        credentialFiles,
      };
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
      const encrypted = this.vault.encryptBuffer(compressed, { purpose: 'backup', aad: BACKUP_FORMAT });
      const stamp = payload.createdAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
      const name = `atomicmail-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}.ambak`;
      const target = path.join(this.config.backupDir, name);
      atomicWrite(target, encrypted);

      // A backup is not considered successful until it can be authenticated,
      // decompressed and its SQLite snapshot passes integrity_check.
      const verification = this.verifyBackup(name);
      this.lastBackupAtMs = Date.now();
      this.prune();
      return { ...verification, reason: payload.reason };
    } finally {
      try { fs.rmSync(dbSnapshot, { force: true }); } catch {}
      try {
        if (fs.existsSync(tempRoot) && fs.readdirSync(tempRoot).length === 0) fs.rmdirSync(tempRoot);
      } catch {}
    }
  }

  decodeBackup(nameOrPath) {
    const filePath = path.isAbsolute(String(nameOrPath || ''))
      ? String(nameOrPath)
      : this.backupPath(nameOrPath);
    const envelope = fs.readFileSync(filePath);
    const compressed = this.vault.decryptBuffer(envelope, { purpose: 'backup', aad: BACKUP_FORMAT });
    let payload;
    try { payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8')); } catch {
      throw new Error('Backup payload is corrupted or not a valid AtomicMail Panel backup');
    }
    if (payload?.format !== BACKUP_FORMAT || payload?.version !== BACKUP_VERSION) throw new Error('Backup format/version is unsupported');
    if (payload.keyFingerprint !== this.vault.keyFingerprint) throw new Error('Backup key fingerprint does not match the active encryption key');
    if (typeof payload.database !== 'string' || !Array.isArray(payload.credentialFiles)) throw new Error('Backup payload is incomplete');
    return { filePath, payload };
  }

  verifyBackup(nameOrPath) {
    const { filePath, payload } = this.decodeBackup(nameOrPath);
    const tempRoot = path.join(this.config.dataDir, '.backup-verify');
    const dbBuffer = Buffer.from(payload.database, 'base64');
    validateDatabaseBuffer(dbBuffer, tempRoot);

    for (const file of payload.credentialFiles) {
      const relative = String(file.path || '').replaceAll('\\', '/');
      if (!relative.endsWith('.enc') || relative.startsWith('../') || relative.includes('/../')) throw new Error('Backup contains an unsafe credential path');
      // Validate the base64 shape without decrypting individual credential
      // envelopes; the entire backup is already authenticated by AES-GCM.
      if (typeof file.data !== 'string' || Buffer.from(file.data, 'base64').length === 0) throw new Error(`Backup credential file ${relative} is invalid`);
    }

    try { if (fs.existsSync(tempRoot) && fs.readdirSync(tempRoot).length === 0) fs.rmdirSync(tempRoot); } catch {}
    return {
      name: path.basename(filePath),
      createdAt: payload.createdAt,
      credentialFiles: payload.credentialFiles.length,
      sizeBytes: fs.statSync(filePath).size,
      verified: true,
    };
  }

  restoreBackup(nameOrPath) {
    const { payload } = this.decodeBackup(nameOrPath);
    const tempRoot = path.join(this.config.dataDir, `.restore-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
    const tempDb = path.join(tempRoot, 'atomicmail-panel.sqlite');
    const tempCredentials = path.join(tempRoot, 'credentials');
    ensureDir(tempRoot);
    ensureDir(tempCredentials);

    try {
      fs.writeFileSync(tempDb, Buffer.from(payload.database, 'base64'), { mode: 0o600 });
      validateDatabaseBuffer(fs.readFileSync(tempDb), path.join(tempRoot, 'verify'));
      for (const file of payload.credentialFiles) {
        const relative = String(file.path || '').replaceAll('\\', '/');
        if (!relative.endsWith('.enc') || relative.startsWith('../') || relative.includes('/../')) throw new Error('Backup contains an unsafe credential path');
        const target = path.join(tempCredentials, relative);
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, Buffer.from(file.data, 'base64'), { mode: 0o600 });
        chmodQuiet(target, 0o600);
      }

      const stamp = new Date().toISOString().replaceAll(':', '-');
      const oldDb = `${this.config.dbPath}.pre-restore-${stamp}`;
      const oldCredentials = `${this.config.credentialsRoot}.pre-restore-${stamp}`;
      let dbMoved = false;
      let credsMoved = false;
      try {
        for (const suffix of ['-wal', '-shm']) {
          try { fs.rmSync(`${this.config.dbPath}${suffix}`, { force: true }); } catch {}
        }
        if (fs.existsSync(this.config.credentialsRoot)) {
          fs.renameSync(this.config.credentialsRoot, oldCredentials);
          credsMoved = true;
        }
        if (fs.existsSync(this.config.dbPath)) {
          fs.renameSync(this.config.dbPath, oldDb);
          dbMoved = true;
        }
        ensureDir(path.dirname(this.config.dbPath));
        fs.renameSync(tempCredentials, this.config.credentialsRoot);
        fs.renameSync(tempDb, this.config.dbPath);
        validateDatabaseBuffer(fs.readFileSync(this.config.dbPath), path.join(tempRoot, 'post-verify'));
        if (credsMoved) fs.rmSync(oldCredentials, { recursive: true, force: true });
        if (dbMoved) fs.rmSync(oldDb, { force: true });
      } catch (error) {
        try { fs.rmSync(this.config.credentialsRoot, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(this.config.dbPath, { force: true }); } catch {}
        if (credsMoved && fs.existsSync(oldCredentials)) fs.renameSync(oldCredentials, this.config.credentialsRoot);
        if (dbMoved && fs.existsSync(oldDb)) fs.renameSync(oldDb, this.config.dbPath);
        throw error;
      }

      return { restored: true, createdAt: payload.createdAt, credentialFiles: payload.credentialFiles.length };
    } finally {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
  }

  prune() {
    const keep = Math.max(1, Number(this.config.backupRetention || 14));
    const backups = this.listBackups(100000);
    for (const item of backups.slice(keep)) {
      try { fs.rmSync(path.join(this.config.backupDir, item.name), { force: true }); } catch {}
    }
  }

  requestBackup(reason = 'data-changed') {
    if (!this.config.autoBackupEnabled || !this.store) return;
    if (this.pendingTimer) return;
    const minGap = Math.max(1000, Number(this.config.backupMinGapMs || 300000));
    const delay = Math.max(1000, minGap - (Date.now() - this.lastBackupAtMs));
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.createBackup(reason).catch((error) => {
        try { this.store?.audit('error', 'backup.failed', error?.message || String(error)); } catch {}
      });
    }, delay);
    this.pendingTimer.unref?.();
  }

  start() {
    if (!this.config.autoBackupEnabled || this.interval || !this.store) return;
    const every = Math.max(60000, Number(this.config.autoBackupIntervalMs || 21600000));
    this.interval = setInterval(() => {
      this.createBackup('scheduled').catch((error) => {
        try { this.store?.audit('error', 'backup.failed', error?.message || String(error)); } catch {}
      });
    }, every);
    this.interval.unref?.();
  }

  async stop({ finalBackup = false } = {}) {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.busyPromise) {
      try { await this.busyPromise; } catch {}
    }
    if (finalBackup && this.store && this.store.countMailboxes() > 0) return this.createBackup('shutdown');
    return null;
  }

  status() {
    const latest = this.latestBackup();
    return {
      enabled: Boolean(this.config.autoBackupEnabled),
      intervalMinutes: Math.round(Number(this.config.autoBackupIntervalMs || 0) / 60000),
      minimumGapMinutes: Math.round(Number(this.config.backupMinGapMs || 0) / 60000),
      retention: Number(this.config.backupRetention || 0),
      latest,
      backupCount: this.listBackups(100000).length,
    };
  }
}
