import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './utils.js';

const JOB_STATUSES = new Set(['pending', 'running', 'paused', 'completed', 'cancelled', 'failed']);

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
    `);
  }

  recoverInterruptedWork() {
    const now = nowIso();
    this.db.prepare(`UPDATE job_items SET status='pending', updated_at=? WHERE status='running'`).run(now);
    this.db.prepare(`UPDATE jobs SET status='running', updated_at=? WHERE status='pending'`).run(now);
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

  createJob({ count, prefix, usernames }) {
    const id = newId('job');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO jobs(id, requested_count, prefix, status, created_at, updated_at)
        VALUES(?, ?, ?, 'running', ?, ?)
      `).run(id, count, prefix, now, now);

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
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job) return null;
    const items = this.db.prepare(`
      SELECT id, position, username, status, attempts, next_attempt_at, mailbox_id, last_error, created_at, updated_at
      FROM job_items WHERE job_id=? ORDER BY position
    `).all(id);
    return { ...job, items };
  }

  listJobs(limit = 50) {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
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
    this.db.prepare(`UPDATE job_items SET status='cancelled', updated_at=? WHERE job_id=? AND status='pending'`).run(now, jobId);
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
      UPDATE job_items SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'
    `).run(now, id);
    const item = this.db.prepare('SELECT * FROM job_items WHERE id=?').get(id);
    if (item) {
      this.db.prepare(`UPDATE jobs SET started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?`).run(now, now, item.job_id);
    }
    return item;
  }

  rescheduleItem(id, delayMs, errorMessage) {
    const now = new Date();
    const next = new Date(now.getTime() + delayMs).toISOString();
    this.db.prepare(`
      UPDATE job_items SET status='pending', next_attempt_at=?, last_error=?, updated_at=? WHERE id=?
    `).run(next, errorMessage || null, now.toISOString(), id);
  }

  replaceItemUsername(id, username, delayMs = 1000, errorMessage = null) {
    const now = new Date();
    const next = new Date(now.getTime() + delayMs).toISOString();
    this.db.prepare(`
      UPDATE job_items SET username=?, status='pending', next_attempt_at=?, last_error=?, updated_at=? WHERE id=?
    `).run(username, next, errorMessage, now.toISOString(), id);
  }

  markItemFailed(id, errorMessage) {
    const now = nowIso();
    const item = this.db.prepare('SELECT job_id FROM job_items WHERE id=?').get(id);
    if (!item) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE job_items SET status='failed', last_error=?, updated_at=? WHERE id=?`).run(errorMessage, now, id);
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
      this.db.prepare(`UPDATE job_items SET status='succeeded', mailbox_id=?, last_error=NULL, updated_at=? WHERE id=?`).run(mailboxId, now, id);
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
    if (remaining === 0) {
      const failed = this.db.prepare(`SELECT failed_count FROM jobs WHERE id=?`).get(jobId)?.failed_count ?? 0;
      this.setJobStatus(jobId, failed > 0 ? 'failed' : 'completed');
    }
  }

  listMailboxes(limit = 100, offset = 0) {
    return this.db.prepare(`
      SELECT id, username, email, inbox_id, credentials_path, status, created_at, job_id
      FROM mailboxes ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  countMailboxes() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM mailboxes').get()?.count ?? 0);
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
