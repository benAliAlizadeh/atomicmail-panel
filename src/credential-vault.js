import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJsonParse } from './utils.js';

const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const USERNAME_RE = /^[a-z0-9]{5,21}$/;

function chmodQuiet(target, mode) {
  try { fs.chmodSync(target, mode); } catch {}
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodQuiet(target, 0o700);
}

function parseKey(raw, sourceName) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64'); } catch {}
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new Error(`${sourceName} must contain exactly 32 bytes encoded as base64 or 64 hexadecimal characters`);
  }
  return key;
}

function atomicWrite(filePath, data, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  fs.writeFileSync(temp, data, { mode });
  chmodQuiet(temp, mode);
  fs.renameSync(temp, filePath);
  chmodQuiet(filePath, mode);
}

function walkFiles(root, relative = '') {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    const full = path.join(root, rel);
    if (entry.isDirectory()) rows.push(...walkFiles(root, rel));
    else if (entry.isFile()) rows.push({ relative: rel, full });
  }
  return rows;
}

function safeUsername(username) {
  const value = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(value)) throw new Error('Invalid Atomic Mail username for credential vault');
  return value;
}

function removeTreeQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

export class CredentialVault {
  constructor(config) {
    this.config = config;
    this.masterKey = null;
    this.keySource = null;
    this.keyFingerprint = null;
    this.permissionStatus = null;
  }

  initialize() {
    ensureDir(this.config.credentialsRoot);
    ensureDir(this.config.runtimeCredentialsRoot);
    ensureDir(this.config.secretsDir);

    const fromEnv = parseKey(process.env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
    if (fromEnv) {
      this.masterKey = fromEnv;
      this.keySource = 'environment';
    } else if (fs.existsSync(this.config.encryptionKeyPath)) {
      this.masterKey = parseKey(fs.readFileSync(this.config.encryptionKeyPath, 'utf8'), this.config.encryptionKeyPath);
      this.keySource = 'external-key-file';
      chmodQuiet(this.config.encryptionKeyPath, 0o600);
    } else {
      this.masterKey = crypto.randomBytes(KEY_BYTES);
      this.keySource = 'external-key-file';
      atomicWrite(this.config.encryptionKeyPath, `${this.masterKey.toString('base64')}\n`, 0o600);
    }

    this.keyFingerprint = crypto.createHash('sha256').update(this.masterKey).digest('hex').slice(0, 16);
    return this.status();
  }

  requireReady() {
    if (!this.masterKey) throw new Error('Credential vault is not initialized');
  }

  purposeKey(purpose) {
    this.requireReady();
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      this.masterKey,
      Buffer.from('atomicmail-panel-v1', 'utf8'),
      Buffer.from(String(purpose), 'utf8'),
      KEY_BYTES,
    ));
  }

  encryptBuffer(buffer, { purpose = 'credentials', aad = '' } = {}) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.purposeKey(purpose), iv);
    if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);
    const envelope = {
      v: ENVELOPE_VERSION,
      alg: 'A256GCM',
      purpose,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8');
  }

  decryptBuffer(envelopeBuffer, { purpose = 'credentials', aad = '' } = {}) {
    let envelope;
    try { envelope = JSON.parse(Buffer.from(envelopeBuffer).toString('utf8')); } catch {
      throw new Error('Encrypted data envelope is invalid JSON');
    }
    if (envelope?.v !== ENVELOPE_VERSION || envelope?.alg !== 'A256GCM' || envelope?.purpose !== purpose) {
      throw new Error('Encrypted data envelope format is unsupported or does not match its purpose');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.purposeKey(purpose),
      Buffer.from(envelope.iv, 'base64'),
    );
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    } catch {
      throw new Error('Encrypted data could not be authenticated. The encryption key may be wrong or the file may be corrupted.');
    }
  }

  vaultDir(username) {
    return path.join(this.config.credentialsRoot, safeUsername(username));
  }

  encryptedPath(username, relative = 'credentials.json') {
    const clean = safeUsername(username);
    const normalized = path.normalize(String(relative)).replace(/^([/\\])+/, '');
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('Unsafe credential path');
    return path.join(this.config.credentialsRoot, clean, `${normalized}.enc`);
  }

  credentialsPath(username) {
    return this.encryptedPath(username, 'credentials.json');
  }

  readEncryptedFile(username, relative) {
    const clean = safeUsername(username);
    const filePath = this.encryptedPath(clean, relative);
    const aad = `${clean}/${path.normalize(relative).replaceAll('\\', '/')}`;
    return this.decryptBuffer(fs.readFileSync(filePath), { purpose: 'credentials', aad });
  }

  readCredentials(username) {
    const raw = this.readEncryptedFile(username, 'credentials.json').toString('utf8');
    return safeJsonParse(raw, {});
  }

  hasCredentials(username) {
    return fs.existsSync(this.credentialsPath(username));
  }

  validateCredentials(username, credentials) {
    const clean = safeUsername(username);
    const inboxId = typeof credentials?.inboxId === 'string' ? credentials.inboxId : '';
    const local = inboxId.includes('@') ? inboxId.split('@', 1)[0].toLowerCase() : '';
    const apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey.trim() : '';
    return Boolean(inboxId && local === clean && apiKey);
  }

  writeEncryptedFile(username, relative, plainBuffer) {
    const clean = safeUsername(username);
    const normalized = path.normalize(String(relative)).replaceAll('\\', '/');
    const aad = `${clean}/${normalized}`;
    const target = this.encryptedPath(clean, relative);
    atomicWrite(target, this.encryptBuffer(plainBuffer, { purpose: 'credentials', aad }), 0o600);
    chmodQuiet(path.dirname(target), 0o700);
    return target;
  }

  createRuntimeDir(username) {
    const clean = safeUsername(username);
    ensureDir(this.config.runtimeCredentialsRoot);
    const dir = path.join(
      this.config.runtimeCredentialsRoot,
      `${clean}--${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
    );
    ensureDir(dir);
    return dir;
  }

  runtimeUsername(runtimeDir) {
    const base = path.basename(runtimeDir);
    const username = base.split('--', 1)[0];
    return USERNAME_RE.test(username) ? username : null;
  }

  runtimeCredentials(runtimeDir) {
    const file = path.join(runtimeDir, 'credentials.json');
    if (!fs.existsSync(file)) return null;
    return safeJsonParse(fs.readFileSync(file, 'utf8'), null);
  }

  sealRuntimeDir(username, runtimeDir, { requireUsableCredentials = true } = {}) {
    const clean = safeUsername(username);
    if (!fs.existsSync(runtimeDir)) return null;
    const credentials = this.runtimeCredentials(runtimeDir);
    if (requireUsableCredentials && !this.validateCredentials(clean, credentials)) return null;

    const files = walkFiles(runtimeDir);
    if (!files.length) return null;
    ensureDir(this.vaultDir(clean));
    for (const file of files) {
      this.writeEncryptedFile(clean, file.relative, fs.readFileSync(file.full));
    }
    removeTreeQuiet(runtimeDir);
    return {
      username: clean,
      credentials,
      credentialsPath: this.credentialsPath(clean),
      fileCount: files.length,
    };
  }

  materialize(username) {
    const clean = safeUsername(username);
    if (!this.hasCredentials(clean)) throw new Error(`No encrypted credentials exist for ${clean}`);
    const runtimeDir = this.createRuntimeDir(clean);
    const vaultRoot = this.vaultDir(clean);
    try {
      for (const file of walkFiles(vaultRoot)) {
        if (!file.relative.endsWith('.enc')) continue;
        const relative = file.relative.slice(0, -4);
        const target = path.join(runtimeDir, relative);
        ensureDir(path.dirname(target));
        const plain = this.readEncryptedFile(clean, relative);
        fs.writeFileSync(target, plain, { mode: 0o600 });
        chmodQuiet(target, 0o600);
      }
      return runtimeDir;
    } catch (error) {
      removeTreeQuiet(runtimeDir);
      throw error;
    }
  }

  commitRuntime(username, runtimeDir) {
    return this.sealRuntimeDir(username, runtimeDir, { requireUsableCredentials: true });
  }

  discardRuntime(runtimeDir) {
    removeTreeQuiet(runtimeDir);
  }

  migrateLegacyCredentials() {
    ensureDir(this.config.credentialsRoot);
    let encryptedFiles = 0;
    let migratedMailboxes = 0;
    for (const entry of fs.readdirSync(this.config.credentialsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !USERNAME_RE.test(entry.name)) continue;
      const username = entry.name;
      const dir = path.join(this.config.credentialsRoot, username);
      const plainFiles = walkFiles(dir).filter((file) => !file.relative.endsWith('.enc'));
      if (!plainFiles.length) continue;

      const credentialsFile = plainFiles.find((file) => file.relative.replaceAll('\\', '/') === 'credentials.json');
      if (credentialsFile) {
        const credentials = safeJsonParse(fs.readFileSync(credentialsFile.full, 'utf8'), null);
        if (!this.validateCredentials(username, credentials)) {
          throw new Error(`Refusing to encrypt mismatched or incomplete credentials for ${username}`);
        }
      }

      for (const file of plainFiles) {
        const plain = fs.readFileSync(file.full);
        const target = this.writeEncryptedFile(username, file.relative, plain);
        // Authenticate what we wrote before deleting the only plaintext copy.
        const roundTrip = this.readEncryptedFile(username, file.relative);
        if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(plain).digest(), crypto.createHash('sha256').update(roundTrip).digest())) {
          throw new Error(`Credential encryption verification failed for ${target}`);
        }
        fs.unlinkSync(file.full);
        encryptedFiles += 1;
      }
      migratedMailboxes += 1;
    }
    return { migratedMailboxes, encryptedFiles };
  }

  recoverRuntimeDirectories() {
    ensureDir(this.config.runtimeCredentialsRoot);
    let recovered = 0;
    let discarded = 0;
    for (const entry of fs.readdirSync(this.config.runtimeCredentialsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runtimeDir = path.join(this.config.runtimeCredentialsRoot, entry.name);
      const username = this.runtimeUsername(runtimeDir);
      if (!username) {
        removeTreeQuiet(runtimeDir);
        discarded += 1;
        continue;
      }
      const credentials = this.runtimeCredentials(runtimeDir);
      if (this.validateCredentials(username, credentials)) {
        this.sealRuntimeDir(username, runtimeDir, { requireUsableCredentials: true });
        recovered += 1;
      } else {
        removeTreeQuiet(runtimeDir);
        discarded += 1;
      }
    }
    return { recovered, discarded };
  }

  listEncryptedFiles() {
    return walkFiles(this.config.credentialsRoot).filter((file) => file.relative.endsWith('.enc'));
  }

  plaintextCredentialFiles() {
    return walkFiles(this.config.credentialsRoot).filter((file) => !file.relative.endsWith('.enc'));
  }

  status() {
    const encrypted = fs.existsSync(this.config.credentialsRoot) ? this.listEncryptedFiles().length : 0;
    const plaintext = fs.existsSync(this.config.credentialsRoot) ? this.plaintextCredentialFiles().length : 0;
    let runtimeDirectories = 0;
    try { runtimeDirectories = fs.readdirSync(this.config.runtimeCredentialsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length; } catch {}
    return {
      encryption: 'AES-256-GCM',
      encryptedCredentialFiles: encrypted,
      plaintextCredentialFiles: plaintext,
      runtimeCredentialDirectories: runtimeDirectories,
      keySource: this.keySource,
      keyFingerprint: this.keyFingerprint,
      portable: true,
      filePermissions: this.permissionStatus,
    };
  }
}
