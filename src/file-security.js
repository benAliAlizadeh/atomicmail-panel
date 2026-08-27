import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}

function currentWindowsSid() {
  const raw = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const match = raw.match(/S-1-[0-9-]+/i);
  if (!match) throw new Error('Unable to resolve current Windows user SID');
  return match[0];
}

function hardenWindowsDirectory(target, sid) {
  // Do not recursively remove inheritance on Windows. Applying directory-only
  // inheritance flags to every child file can leave existing files unreadable.
  // Encryption is the primary protection; here we preserve the parent ACL and
  // add inheritable Full Control for the current user and SYSTEM.
  execFileSync('icacls', [
    target,
    '/inheritance:e',
    '/grant:r', `*${sid}:(OI)(CI)F`,
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
    '/C', '/Q',
  ], { windowsHide: true, stdio: 'ignore' });
}


function hardenWindowsFile(target, sid) {
  if (!fs.existsSync(target)) return;
  execFileSync('icacls', [
    target,
    '/inheritance:r',
    '/grant:r', `*${sid}:F`,
    '/grant:r', '*S-1-5-18:F',
    '/Q',
  ], { windowsHide: true, stdio: 'ignore' });
}

export function hardenStoragePaths(config) {
  const targets = [config.dataDir, config.secretsDir, config.backupDir];
  for (const target of targets) ensureDir(target);

  if (process.platform === 'win32') {
    try {
      const sid = currentWindowsSid();
      for (const target of targets) hardenWindowsDirectory(target, sid);
      hardenWindowsFile(config.encryptionKeyPath, sid);
      return { platform: 'windows', hardened: true, method: 'NTFS ACL inheritance preserved; current user + SYSTEM granted', warning: null };
    } catch (error) {
      return {
        platform: 'windows',
        hardened: false,
        method: 'NTFS ACL hardening failed',
        warning: error?.message || String(error),
      };
    }
  }

  const warnings = [];
  for (const target of targets) {
    try { fs.chmodSync(target, 0o700); } catch (error) { warnings.push(`${target}: ${error?.message || error}`); }
  }
  try { if (fs.existsSync(config.encryptionKeyPath)) fs.chmodSync(config.encryptionKeyPath, 0o600); } catch (error) { warnings.push(`${config.encryptionKeyPath}: ${error?.message || error}`); }
  return {
    platform: process.platform,
    hardened: warnings.length === 0,
    method: 'directory mode 0700; secret files mode 0600',
    warning: warnings.length ? warnings.join('; ') : null,
  };
}
