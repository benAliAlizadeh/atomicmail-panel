import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './utils.js';

const JOB_STATUSES = new Set(['pending', 'running', 'paused', 'completed', 'cancelled', 'failed']);

function searchPattern(value) {
  const clean = String(value || '').trim().slice(0, 100);
  return clean ? `%${clean}%` : '';
}

export class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        requested_count INTEGER NOT NULL,
        prefix TEXT NOT NULL DEFAULT '',
        destination_password_ciphertext TEXT,
        status TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS job_items (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        mailbox_id TEXT,
        last_error TEXT,
        phase TEXT NOT NULL DEFAULT 'queued',
        phase_message TEXT,
        phase_updated_at TEXT,
        attempt_started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, position),
        UNIQUE(job_id, username)
      );

      CREATE INDEX IF NOT EXISTS idx_job_items_runnable
      ON job_items(status, next_attempt_at, job_id, position);

      CREATE TABLE IF NOT EXISTS mailboxes (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        inbox_id TEXT NOT NULL,
        credentials_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        job_id TEXT,
        job_item_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mailboxes_created_at ON mailboxes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mailboxes_username ON mailboxes(username);

      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        job_id TEXT,
        job_item_id TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cloudflare_jobs (
        id TEXT PRIMARY KEY,
        requested_count INTEGER NOT NULL,
        password_mode TEXT NOT NULL,
        password_ciphertext TEXT NOT NULL,
        status TEXT NOT NULL,
        verified_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        needs_action_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        last_error_code TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS cloudflare_accounts (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL UNIQUE REFERENCES mailboxes(id) ON DELETE RESTRICT,
        email TEXT NOT NULL UNIQUE,
        credential_job_id TEXT NOT NULL REFERENCES cloudflare_jobs(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        cloudflare_account_id TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error_code TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS cloudflare_job_items (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES cloudflare_jobs(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE RESTRICT,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'queued',
        phase_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        submitted_at TEXT,
        verification_received_at TEXT,
        verified_at TEXT,
        last_error_code TEXT,
        last_error TEXT,
        artifact_name TEXT,
        browser_state_ciphertext TEXT,
        verification_url_ciphertext TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        leased_runner_id TEXT,
        lease_expires_at TEXT,
        attempt_started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, position),
        UNIQUE(job_id, mailbox_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cloudflare_items_runnable
      ON cloudflare_job_items(status, next_attempt_at, job_id, position);

      CREATE INDEX IF NOT EXISTS idx_cloudflare_items_lease
      ON cloudflare_job_items(lease_expires_at, leased_runner_id);
    `);

    // Additive migration for databases created by earlier panel stages.
    const jobColumns = new Set(this.db.prepare(`PRAGMA table_info(jobs)`).all().map((row) => row.name));
    if (!jobColumns.has('destination_password_ciphertext')) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN destination_password_ciphertext TEXT`);
    }
    const jobItemColumns = new Set(this.db.prepare(`PRAGMA table_info(job_items)`).all().map((row) => row.name));
    const additions = [
      ['phase', `TEXT NOT NULL DEFAULT 'queued'`],
      ['phase_message', 'TEXT'],
      ['phase_updated_at', 'TEXT'],
      ['attempt_started_at', 'TEXT'],
      ['finished_at', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
      if (!jobItemColumns.has(name)) this.db.exec(`ALTER TABLE job_items ADD COLUMN ${name} ${definition}`);
    }
  }

  recoverInterruptedWork() {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    let interruptedItems = 0;
    let cancelledItems = 0;
    let reopenedJobs = 0;
    try {
      const cancelled = this.db.prepare(`
        UPDATE job_items
        SET status='cancelled',
            phase='cancelled',
            phase_message='Cancelled after interrupted worker process',
            phase_updated_at=?,
            finished_at=?,
            updated_at=?
        WHERE status='running'
          AND job_id IN (SELECT id FROM jobs WHERE status='cancelled')
      `).run(now, now, now);
      cancelledItems = Number(cancelled.changes || 0);

      const reopened = this.db.prepare(`
        UPDATE jobs
        SET status='running', completed_at=NULL, updated_at=?
        WHERE status IN ('completed','failed')
          AND id IN (SELECT DISTINCT job_id FROM job_items WHERE status='running')
      `).run(now);
      reopenedJobs = Number(reopened.changes || 0);

      const recovered = this.db.prepare(`
        UPDATE job_items
        SET status='pending',
            attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
            next_attempt_at=?,
            last_error=COALESCE(last_error, 'Recovered after interrupted worker process'),
            phase='queued',
            phase_message='Recovered after restart; waiting to resume',
            phase_updated_at=?,
            attempt_started_at=NULL,
            finished_at=NULL,
            updated_at=?
        WHERE status='running'
      `).run(now, now, now);
      interruptedItems = Number(recovered.changes || 0);

      this.db.prepare(`
        UPDATE jobs
        SET status='running', updated_at=?
        WHERE status='pending'
      `).run(now);

      this.db.prepare(`
        UPDATE jobs
        SET success_count=(
              SELECT COUNT(*) FROM job_items ji
              WHERE ji.job_id=jobs.id AND ji.status='succeeded'
            ),
            failed_count=(
              SELECT COUNT(*) FROM job_items ji
              WHERE ji.job_id=jobs.id AND ji.status='failed'
            ),
            updated_at=?
      `).run(now);

      this.db.prepare(`
        UPDATE jobs
        SET status=CASE WHEN failed_count > 0 THEN 'failed' ELSE 'completed' END,
            completed_at=COALESCE(completed_at, ?),
            updated_at=?
        WHERE status='running'
          AND NOT EXISTS (
            SELECT 1 FROM job_items ji
            WHERE ji.job_id=jobs.id AND ji.status IN ('pending','running')
          )
      `).run(now, now);

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const summary = { interruptedItems, cancelledItems, reopenedJobs };
    if (interruptedItems || cancelledItems || reopenedJobs) {
      this.audit(
        'warn',
        'worker.recovered',
        `Recovered ${interruptedItems} interrupted item(s), ${cancelledItems} cancelled in-flight item(s), ${reopenedJobs} inconsistent terminal job(s)`,
      );
    }
    return summary;
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  createSnapshot(targetPath) {
    const escaped = String(targetPath).replaceAll("'", "''");
    try { fs.rmSync(targetPath, { force: true }); } catch {}
    this.db.exec(`VACUUM INTO '${escaped}'`);
    try { fs.chmodSync(targetPath, 0o600); } catch {}
    return targetPath;
  }

  rebaseCredentialPaths(credentialsRoot) {
    const rows = this.db.prepare(`SELECT id, username, credentials_path FROM mailboxes`).all();
    const update = this.db.prepare(`UPDATE mailboxes SET credentials_path=? WHERE id=?`);
    let changed = 0;
    for (const row of rows) {
      const expected = path.join(credentialsRoot, row.username, 'credentials.json.enc');
      if (row.credentials_path !== expected) {
        update.run(expected, row.id);
        changed += 1;
      }
    }
    return changed;
  }

  isUsernameTaken(username) {
    const row = this.db.prepare(`
      SELECT 1 AS found FROM mailboxes WHERE username=?
      UNION ALL
      SELECT 1 AS found FROM job_items WHERE username=? AND status IN ('pending','running','succeeded')
      LIMIT 1
    `).get(username, username);
    return Boolean(row);
  }

  createJob({ count, prefix, usernames, id = newId('job'), destinationPasswordCiphertext = null }) {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO jobs(id, requested_count, prefix, destination_password_ciphertext, status, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'running', ?, ?)
      `).run(id, count, prefix, destinationPasswordCiphertext, now, now);

      const insert = this.db.prepare(`
        INSERT INTO job_items(id, job_id, position, username, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `);
      usernames.forEach((username, index) => {
        insert.run(newId('item'), id, index + 1, username, now, now, now);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.audit('info', 'job.created', `Created batch with ${count} item(s)`, id);
    return this.getJob(id);
  }

  getJob(id) {
    const job = this.db.prepare(`
      SELECT id, requested_count, prefix, status, success_count, failed_count,
             created_at, updated_at, started_at, completed_at, last_error,
             destination_password_ciphertext IS NOT NULL AS has_destination_password
      FROM jobs WHERE id=?
    `).get(id);
    if (!job) return null;
    const items = this.db.prepare(`
      SELECT id, position, username, status, attempts, next_attempt_at, mailbox_id, last_error,
             phase, phase_message, phase_updated_at, attempt_started_at, finished_at, created_at, updated_at
      FROM job_items WHERE job_id=? ORDER BY position
    `).all(id);
    const timingRow = this.db.prepare(`
      SELECT COUNT(*) AS sample_count,
             AVG((julianday(finished_at) - julianday(attempt_started_at)) * 86400.0) AS average_success_seconds
      FROM job_items
      WHERE job_id=? AND status='succeeded' AND attempt_started_at IS NOT NULL AND finished_at IS NOT NULL
    `).get(id);
    return {
      ...job,
      items,
      timing: {
        sample_count: Number(timingRow?.sample_count || 0),
        average_success_seconds: timingRow?.average_success_seconds == null ? null : Number(timingRow.average_success_seconds),
      },
    };
  }

  listJobs(limit = 50) {
    return this.db.prepare(`
      SELECT id, requested_count, prefix, status, success_count, failed_count,
             created_at, updated_at, started_at, completed_at, last_error,
             destination_password_ciphertext IS NOT NULL AS has_destination_password
      FROM jobs ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }

  getDashboardStats() {
    const totalMailboxes = this.countMailboxes();
    const todayStart = `${nowIso().slice(0, 10)}T00:00:00.000Z`;
    const createdToday = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM mailboxes WHERE created_at>=?`).get(todayStart)?.count ?? 0);
    const failedItems = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM job_items WHERE status='failed'`).get()?.count ?? 0);
    const statusRows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`).all();
    const jobs = { running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 };
    for (const row of statusRows) jobs[row.status] = Number(row.count);
    const activeJobRow = this.db.prepare(`
      SELECT id
      FROM jobs
      WHERE status IN ('running','paused')
      ORDER BY created_at DESC
      LIMIT 1
    `).get() || null;
    const activeJob = activeJobRow ? this.getJob(activeJobRow.id) : null;
    return { totalMailboxes, createdToday, failedItems, jobs, activeJob };
  }

  setJobStatus(id, status) {
    if (!JOB_STATUSES.has(status)) throw new Error('Invalid job status');
    const now = nowIso();
    const fields = status === 'completed' || status === 'cancelled'
      ? `status=?, updated_at=?, completed_at=?`
      : `status=?, updated_at=?`;
    const result = status === 'completed' || status === 'cancelled'
      ? this.db.prepare(`UPDATE jobs SET ${fields} WHERE id=?`).run(status, now, now, id)
      : this.db.prepare(`UPDATE jobs SET ${fields} WHERE id=?`).run(status, now, id);
    return result.changes > 0;
  }

  cancelPendingItems(jobId) {
    const now = nowIso();
    this.db.prepare(`
      UPDATE job_items
      SET status='cancelled', phase='cancelled', phase_message='Cancelled by operator', phase_updated_at=?, finished_at=?, updated_at=?
      WHERE job_id=? AND status='pending'
    `).run(now, now, now, jobId);
  }

  nextRunnableItem() {
    const now = nowIso();
    return this.db.prepare(`
      SELECT ji.*, j.prefix
      FROM job_items ji
      JOIN jobs j ON j.id=ji.job_id
      WHERE j.status='running' AND ji.status='pending' AND ji.next_attempt_at<=?
      ORDER BY j.created_at, ji.position
      LIMIT 1
    `).get(now) || null;
  }

  markItemRunning(id) {
    const now = nowIso();
    this.db.prepare(`
      UPDATE job_items
      SET status='running', attempts=attempts+1,
          phase='starting', phase_message='Preparing Atomic Mail registration', phase_updated_at=?,
          attempt_started_at=?, finished_at=NULL, updated_at=?
      WHERE id=? AND status='pending'
    `).run(now, now, now, id);
    const item = this.db.prepare('SELECT * FROM job_items WHERE id=?').get(id);
    if (item) {
      this.db.prepare(`UPDATE jobs SET started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?`).run(now, now, item.job_id);
    }
    return item;
  }

  updateItemProgress(id, phase, message) {
    const now = nowIso();
    const safePhase = String(phase || 'working').slice(0, 64);
    const safeMessage = String(message || 'Registration in progress').slice(0, 500);
    const result = this.db.prepare(`
      UPDATE job_items
      SET phase=?, phase_message=?, phase_updated_at=?, updated_at=?
      WHERE id=? AND status='running'
    `).run(safePhase, safeMessage, now, now, id);
    return result.changes > 0;
  }

  rescheduleItem(id, delayMs, errorMessage) {
    const now = new Date();
    const next = new Date(now.getTime() + delayMs).toISOString();
    this.db.prepare(`
      UPDATE job_items
      SET status='pending', next_attempt_at=?, last_error=?,
          phase='waiting_retry', phase_message=?, phase_updated_at=?, attempt_started_at=NULL, finished_at=NULL, updated_at=?
      WHERE id=?
    `).run(next, errorMessage || null, errorMessage || 'Waiting before retry', now.toISOString(), now.toISOString(), id);
  }

  rescheduleInterruptedItem(id, errorMessage = 'Worker stopped before registration completed') {
    const now = nowIso();
    this.db.prepare(`
      UPDATE job_items
      SET status=CASE
            WHEN (SELECT status FROM jobs WHERE jobs.id=job_items.job_id)='cancelled' THEN 'cancelled'
            ELSE 'pending'
          END,
          attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
          next_attempt_at=?,
          last_error=?,
          phase=CASE
            WHEN (SELECT status FROM jobs WHERE jobs.id=job_items.job_id)='cancelled' THEN 'cancelled'
            ELSE 'queued'
          END,
          phase_message=?,
          phase_updated_at=?,
          attempt_started_at=NULL,
          finished_at=CASE
            WHEN (SELECT status FROM jobs WHERE jobs.id=job_items.job_id)='cancelled' THEN ?
            ELSE NULL
          END,
          updated_at=?
      WHERE id=? AND status='running'
    `).run(now, errorMessage, errorMessage, now, now, now, id);
  }

  replaceItemUsername(id, username, delayMs = 1000, errorMessage = null) {
    const now = new Date();
    const next = new Date(now.getTime() + delayMs).toISOString();
    this.db.prepare(`
      UPDATE job_items
      SET username=?, status='pending', next_attempt_at=?, last_error=?,
          phase='queued', phase_message='Username regenerated; waiting to retry', phase_updated_at=?,
          attempt_started_at=NULL, finished_at=NULL, updated_at=?
      WHERE id=?
    `).run(username, next, errorMessage, now.toISOString(), now.toISOString(), id);
  }

  markItemFailed(id, errorMessage) {
    const now = nowIso();
    const item = this.db.prepare('SELECT job_id FROM job_items WHERE id=?').get(id);
    if (!item) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE job_items
        SET status='failed', last_error=?, phase='failed', phase_message=?, phase_updated_at=?, finished_at=?, updated_at=?
        WHERE id=?
      `).run(errorMessage, errorMessage, now, now, now, id);
      this.db.prepare(`UPDATE jobs SET failed_count=failed_count+1, last_error=?, updated_at=? WHERE id=?`).run(errorMessage, now, item.job_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.finalizeJobIfDone(item.job_id);
  }

  markItemSucceeded(id, mailbox) {
    const now = nowIso();
    const item = this.db.prepare('SELECT * FROM job_items WHERE id=?').get(id);
    if (!item) throw new Error('Job item not found');
    const mailboxId = newId('mbx');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO mailboxes(id, username, email, inbox_id, credentials_path, status, created_at, job_id, job_item_id)
        VALUES(?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(mailboxId, mailbox.username, mailbox.email, mailbox.inboxId, mailbox.credentialsPath, now, item.job_id, id);
      this.db.prepare(`
        UPDATE job_items
        SET status='succeeded', mailbox_id=?, last_error=NULL,
            phase='completed', phase_message='Mailbox created successfully', phase_updated_at=?, finished_at=?, updated_at=?
        WHERE id=?
      `).run(mailboxId, now, now, now, id);
      this.db.prepare(`UPDATE jobs SET success_count=success_count+1, updated_at=? WHERE id=?`).run(now, item.job_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.finalizeJobIfDone(item.job_id);
    return mailboxId;
  }

  finalizeJobIfDone(jobId) {
    const remaining = this.db.prepare(`
      SELECT COUNT(*) AS count FROM job_items WHERE job_id=? AND status IN ('pending','running')
    `).get(jobId)?.count ?? 0;
    if (remaining !== 0) return;

    const job = this.db.prepare(`SELECT status, failed_count FROM jobs WHERE id=?`).get(jobId);
    if (!job || job.status === 'cancelled') return;
    this.setJobStatus(jobId, Number(job.failed_count) > 0 ? 'failed' : 'completed');
  }

  getMailbox(id) {
    return this.db.prepare(`
      SELECT m.id, m.username, m.email, m.status, m.created_at, m.job_id,
             j.destination_password_ciphertext IS NOT NULL AS has_destination_password
      FROM mailboxes m LEFT JOIN jobs j ON j.id=m.job_id WHERE m.id=?
    `).get(String(id || '')) || null;
  }

  listMailboxes(limit = 100, offset = 0, search = '') {
    const pattern = searchPattern(search);
    if (!pattern) {
      return this.db.prepare(`
        SELECT m.id, m.username, m.email, m.status, m.created_at, m.job_id,
               j.destination_password_ciphertext IS NOT NULL AS has_destination_password
        FROM mailboxes m LEFT JOIN jobs j ON j.id=m.job_id
        ORDER BY m.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }
    return this.db.prepare(`
      SELECT m.id, m.username, m.email, m.status, m.created_at, m.job_id,
             j.destination_password_ciphertext IS NOT NULL AS has_destination_password
      FROM mailboxes m LEFT JOIN jobs j ON j.id=m.job_id
      WHERE m.username LIKE ? OR m.email LIKE ?
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `).all(pattern, pattern, limit, offset);
  }

  countMailboxes(search = '') {
    const pattern = searchPattern(search);
    if (!pattern) return Number(this.db.prepare('SELECT COUNT(*) AS count FROM mailboxes').get()?.count ?? 0);
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM mailboxes WHERE username LIKE ? OR email LIKE ?
    `).get(pattern, pattern)?.count ?? 0);
  }

  hasBackupData() {
    const row = this.db.prepare(`
      SELECT EXISTS(SELECT 1 FROM jobs LIMIT 1)
          OR EXISTS(SELECT 1 FROM mailboxes LIMIT 1)
          OR EXISTS(SELECT 1 FROM cloudflare_jobs LIMIT 1) AS found
    `).get();
    return Boolean(row?.found);
  }

  exportMailboxes(search = '', limit = 50000) {
    return this.listMailboxes(limit, 0, search);
  }

  getJobPasswordCiphertext(jobId) {
    const row = this.db.prepare(`
      SELECT id, destination_password_ciphertext
      FROM jobs WHERE id=?
    `).get(String(jobId || ''));
    return row || null;
  }

  getMailboxPasswordCiphertext(mailboxId) {
    const row = this.db.prepare(`
      SELECT m.id AS mailbox_id, m.email, m.job_id, j.destination_password_ciphertext
      FROM mailboxes m
      LEFT JOIN jobs j ON j.id=m.job_id
      WHERE m.id=?
    `).get(String(mailboxId || ''));
    return row || null;
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM system_state WHERE key=?').get(key);
    return row ? row.value : fallback;
  }

  setState(key, value) {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO system_state(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value), now);
  }

  clearState(key) {
    this.db.prepare('DELETE FROM system_state WHERE key=?').run(key);
  }

  audit(level, event, message, jobId = null, jobItemId = null) {
    this.db.prepare(`
      INSERT INTO audit_logs(id, level, event, job_id, job_item_id, message, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(newId('log'), level, event, jobId, jobItemId, message, nowIso());
  }

  recentAudit(limit = 100) {
    return this.db.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
}
