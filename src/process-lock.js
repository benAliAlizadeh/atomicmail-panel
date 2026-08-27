import fs from 'node:fs';
import path from 'node:path';

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function readPidLock(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const pid = Number.parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function assertPanelStopped(filePath) {
  const pid = readPidLock(filePath);
  if (!pid) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    return;
  }
  if (pidIsAlive(pid) && pid !== process.pid) {
    throw new Error(`AtomicMail Panel is still running as PID ${pid}. Stop it before restoring a backup.`);
  }
  try { fs.rmSync(filePath, { force: true }); } catch {}
}

export function acquirePidLock(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = readPidLock(filePath);
  if (existing && existing !== process.pid && pidIsAlive(existing)) {
    throw new Error(`Another AtomicMail Panel process is already running as PID ${existing}`);
  }
  fs.writeFileSync(filePath, `${process.pid}\n`, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return () => {
    const current = readPidLock(filePath);
    if (current === process.pid) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  };
}
