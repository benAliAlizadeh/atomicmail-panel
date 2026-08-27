import { newId, nowIso } from './utils.js';

const JOB_STATUSES = new Set(['running', 'paused', 'needs_action', 'completed', 'failed', 'cancelled']);
const TERMINAL_ITEM_STATUSES = new Set(['verified', 'failed', 'cancelled']);
const ACTIVE_ITEM_STATUSES = [
  'preparing', 'creating', 'awaiting_submit', 'waiting_for_verification', 'verifying', 'needs_action',
];
const UNCERTAIN_SIGNUP_CODES = new Set([
  'interrupted_submit_unknown', 'runner_disconnected_uncertain', 'paused_submit_unknown',
  'submit_timeout', 'submission_state_unknown', 'signup_acceptance_unconfirmed', 'account_exists', 'invalid_credentials',
  'reconcile_timeout', 'verification_link_expired', 'challenge', 'challenge_timeout',
  'rate_limited', 'policy_blocked',
]);

function exposedError(message, statusCode = 400, code = 'invalid_cloudflare_request') {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function cleanMessage(value, fallback = '') {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 700);
}

function publicJobColumns(alias = 'j') {
  return `${alias}.id, ${alias}.requested_count, ${alias}.password_mode, ${alias}.status,
          ${alias}.verified_count, ${alias}.failed_count, ${alias}.needs_action_count,
          ${alias}.created_at, ${alias}.updated_at, ${alias}.started_at, ${alias}.completed_at,
          ${alias}.last_error_code, ${alias}.last_error,
          ${alias}.password_ciphertext IS NOT NULL AS has_password`;
}

function publicItemColumns(alias = 'i') {
  return `${alias}.id, ${alias}.job_id, ${alias}.account_id, ${alias}.mailbox_id, ${alias}.position,
          ${alias}.email, ${alias}.status, ${alias}.phase, ${alias}.phase_message, ${alias}.attempts,
          ${alias}.next_attempt_at, ${alias}.submitted_at, ${alias}.signup_acceptance_evidence,
          ${alias}.verification_wait_started_at, ${alias}.last_inbox_check_at, ${alias}.verification_received_at,
          ${alias}.verified_at, ${alias}.last_error_code, ${alias}.last_error,
          ${alias}.artifact_name IS NOT NULL AS has_artifact,
          ${alias}.lease_generation, ${alias}.leased_runner_id, ${alias}.lease_expires_at,
          ${alias}.attempt_started_at, ${alias}.finished_at, ${alias}.created_at, ${alias}.updated_at`;
}

export class CloudflareStore {
  constructor(store) {
    if (!store?.db) throw new Error('CloudflareStore requires the primary SQLite store');
    this.store = store;
    this.db = store.db;
  }

  recoverInterruptedWork() {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const safe = this.db.prepare(`
        UPDATE cloudflare_job_items
        SET status='queued', phase='queued', phase_message='Recovered before Cloudflare submission',
            attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
            leased_runner_id=NULL, lease_expires_at=NULL, next_attempt_at=?, updated_at=?
        WHERE status='preparing'
      `).run(now, now);
      const uncertain = this.db.prepare(`
        UPDATE cloudflare_job_items
        SET status='needs_action', phase='needs_action',
            phase_message='Runner stopped near the manual submit step; reconcile before retrying',
            last_error_code='interrupted_submit_unknown',
            last_error='Cloudflare may have accepted the form before the runner disconnected',
            leased_runner_id=NULL, lease_expires_at=NULL, updated_at=?
        WHERE status IN ('creating','awaiting_submit')
      `).run(now);
      const verifying = this.db.prepare(`
        UPDATE cloudflare_job_items
        SET status='waiting_for_verification', phase='waiting_for_verification',
            phase_message='Recovered verification after restart', leased_runner_id=NULL,
            lease_expires_at=NULL, next_attempt_at=?, updated_at=?
        WHERE status='verifying'
      `).run(now, now);
      const unconfirmed = this.db.prepare(`
        UPDATE cloudflare_job_items
        SET status='needs_action', phase='needs_action',
            phase_message='Signup acceptance was not confirmed by the browser; open Cloudflare and reconcile',
            last_error_code='signup_acceptance_unconfirmed',
            last_error='The previous runner protocol did not preserve reliable browser acceptance evidence',
            leased_runner_id=NULL, lease_expires_at=NULL, updated_at=?
        WHERE status='waiting_for_verification' AND signup_acceptance_evidence IS NULL
      `).run(now);
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='needs_action',
          last_error_code=COALESCE((
            SELECT i.last_error_code FROM cloudflare_job_items i
            WHERE i.account_id=cloudflare_accounts.id AND i.status='needs_action'
            ORDER BY i.updated_at DESC LIMIT 1
          ), 'interrupted_submit_unknown'),
          last_error=COALESCE((
            SELECT i.last_error FROM cloudflare_job_items i
            WHERE i.account_id=cloudflare_accounts.id AND i.status='needs_action'
            ORDER BY i.updated_at DESC LIMIT 1
          ), 'Cloudflare may have accepted the form before the runner disconnected'), updated_at=?
        WHERE id IN (SELECT account_id FROM cloudflare_job_items WHERE status='needs_action')
      `).run(now);
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='waiting_for_verification', updated_at=?
        WHERE id IN (SELECT account_id FROM cloudflare_job_items WHERE status='waiting_for_verification')
          AND status<>'verified'
      `).run(now);
      this.db.prepare(`
        UPDATE cloudflare_jobs
        SET status='needs_action', needs_action_count=(
          SELECT COUNT(*) FROM cloudflare_job_items i WHERE i.job_id=cloudflare_jobs.id AND i.status='needs_action'
        ), updated_at=?
        WHERE EXISTS(SELECT 1 FROM cloudflare_job_items i WHERE i.job_id=cloudflare_jobs.id AND i.status='needs_action')
          AND status NOT IN ('cancelled','completed')
      `).run(now);
      this.db.exec('COMMIT');
      const summary = {
        queued: Number(safe.changes || 0),
        needsAction: Number(uncertain.changes || 0),
        verificationRecovered: Number(verifying.changes || 0),
        signupAcceptanceUnconfirmed: Number(unconfirmed.changes || 0),
      };
      if (summary.queued || summary.needsAction || summary.verificationRecovered || summary.signupAcceptanceUnconfirmed) {
        this.store.audit('warn', 'cloudflare.recovered', `Recovered Cloudflare work: ${JSON.stringify(summary)}`);
      }
      return summary;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createJob({ mailboxIds, passwordMode, passwordCiphertext, id = newId('cfjob') }) {
    if (!Array.isArray(mailboxIds) || mailboxIds.length < 1 || mailboxIds.length > 100) {
      throw exposedError('Select between 1 and 100 mailboxes');
    }
    const uniqueIds = [...new Set(mailboxIds.map((value) => String(value || '').trim()).filter(Boolean))];
    if (uniqueIds.length !== mailboxIds.length) throw exposedError('Mailbox selection contains duplicates');
    if (!['manual', 'generated'].includes(passwordMode)) throw exposedError('Cloudflare password mode is invalid');
    if (!passwordCiphertext) throw exposedError('Encrypted Cloudflare password is required', 503, 'vault_unavailable');

    const rows = this.db.prepare(`
      SELECT id, username, email, status FROM mailboxes
      WHERE id IN (${placeholders(uniqueIds.length)})
    `).all(...uniqueIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (rows.length !== uniqueIds.length) throw exposedError('One or more selected mailboxes do not exist', 404, 'mailbox_not_found');
    const inactive = rows.find((row) => row.status !== 'active');
    if (inactive) throw exposedError(`${inactive.email} is not an active mailbox`, 409, 'mailbox_inactive');
    const tracked = this.db.prepare(`
      SELECT ca.email, ca.status FROM cloudflare_accounts ca
      WHERE ca.mailbox_id IN (${placeholders(uniqueIds.length)})
        AND NOT (ca.status='cancelled' AND ca.last_error_code IS NULL) LIMIT 1
    `).get(...uniqueIds);
    if (tracked) throw exposedError(`${tracked.email} already has a Cloudflare workflow (${tracked.status})`, 409, 'cloudflare_account_tracked');
    const reusableRows = this.db.prepare(`
      SELECT id, mailbox_id FROM cloudflare_accounts
      WHERE mailbox_id IN (${placeholders(uniqueIds.length)}) AND status='cancelled' AND last_error_code IS NULL
    `).all(...uniqueIds);
    const reusableByMailbox = new Map(reusableRows.map((row) => [row.mailbox_id, row]));

    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO cloudflare_jobs(
          id, requested_count, password_mode, password_ciphertext, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'running', ?, ?)
      `).run(id, uniqueIds.length, passwordMode, passwordCiphertext, now, now);
      const insertAccount = this.db.prepare(`
        INSERT INTO cloudflare_accounts(
          id, mailbox_id, email, credential_job_id, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'queued', ?, ?)
      `);
      const insertItem = this.db.prepare(`
        INSERT INTO cloudflare_job_items(
          id, job_id, account_id, mailbox_id, position, email, status, phase, phase_message,
          next_attempt_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'queued', 'queued', 'Waiting for the Cloudflare browser runner', ?, ?, ?)
      `);
      uniqueIds.forEach((mailboxId, index) => {
        const mailbox = byId.get(mailboxId);
        const reusable = reusableByMailbox.get(mailbox.id);
        const accountId = reusable?.id || newId('cfacct');
        if (reusable) {
          this.db.prepare(`
            UPDATE cloudflare_accounts SET email=?, credential_job_id=?, status='queued',
              cloudflare_account_id=NULL, verified_at=NULL, last_error_code=NULL, last_error=NULL,
              updated_at=? WHERE id=?
          `).run(mailbox.email, id, now, accountId);
        } else {
          insertAccount.run(accountId, mailbox.id, mailbox.email, id, now, now);
        }
        insertItem.run(newId('cfitem'), id, accountId, mailbox.id, index + 1, mailbox.email, now, now, now);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (/UNIQUE constraint/i.test(String(error?.message || ''))) {
        throw exposedError('A selected mailbox already has a Cloudflare workflow', 409, 'cloudflare_account_tracked');
      }
      throw error;
    }
    this.store.audit('info', 'cloudflare.job_created', `Created Cloudflare job with ${uniqueIds.length} mailbox(es)`, id);
    return this.getJob(id);
  }

  getJob(id) {
    const job = this.db.prepare(`SELECT ${publicJobColumns('j')} FROM cloudflare_jobs j WHERE j.id=?`).get(String(id || ''));
    if (!job) return null;
    const items = this.db.prepare(`
      SELECT ${publicItemColumns('i')}, a.cloudflare_account_id
      FROM cloudflare_job_items i
      JOIN cloudflare_accounts a ON a.id=i.account_id
      WHERE i.job_id=? ORDER BY i.position
    `).all(job.id);
    const timing = this.db.prepare(`
      SELECT COUNT(*) AS sample_count,
             AVG((julianday(finished_at)-julianday(attempt_started_at))*86400.0) AS average_verified_seconds
      FROM cloudflare_job_items WHERE job_id=? AND status='verified'
    `).get(job.id);
    const counts = items.reduce((result, item) => {
      if (item.status === 'verified') result.verified_count += 1;
      if (item.status === 'failed') result.failed_count += 1;
      if (item.status === 'needs_action') result.needs_action_count += 1;
      return result;
    }, { verified_count: 0, failed_count: 0, needs_action_count: 0 });
    return {
      ...job,
      ...counts,
      items,
      timing: {
        sample_count: Number(timing?.sample_count || 0),
        average_verified_seconds: timing?.average_verified_seconds == null ? null : Number(timing.average_verified_seconds),
      },
    };
  }

  listJobs(limit = 50) {
    return this.db.prepare(`
      SELECT ${publicJobColumns('j')} FROM cloudflare_jobs j ORDER BY j.created_at DESC LIMIT ?
    `).all(limit);
  }

  listAccounts(limit = 100, offset = 0, search = '') {
    const clean = String(search || '').trim().slice(0, 100);
    const where = clean ? 'WHERE a.email LIKE ?' : '';
    const args = clean ? [`%${clean}%`, limit, offset] : [limit, offset];
    return this.db.prepare(`
      SELECT a.id, a.mailbox_id, a.email, a.status, a.cloudflare_account_id, a.verified_at,
             a.created_at, a.updated_at, a.last_error_code, a.last_error,
             a.credential_job_id AS job_id, j.password_mode, 1 AS has_password
      FROM cloudflare_accounts a JOIN cloudflare_jobs j ON j.id=a.credential_job_id
      ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(...args);
  }

  countAccounts(search = '') {
    const clean = String(search || '').trim().slice(0, 100);
    if (!clean) return Number(this.db.prepare('SELECT COUNT(*) AS count FROM cloudflare_accounts').get()?.count || 0);
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM cloudflare_accounts WHERE email LIKE ?').get(`%${clean}%`)?.count || 0);
  }

  eligibleMailboxMap(mailboxIds) {
    if (!Array.isArray(mailboxIds) || !mailboxIds.length) return new Map();
    const ids = [...new Set(mailboxIds.map(String))];
    const rows = this.db.prepare(`
      SELECT m.id, CASE WHEN a.id IS NULL THEN 1 ELSE 0 END AS cloudflare_eligible,
             a.status AS cloudflare_status, a.last_error_code AS cloudflare_last_error_code
      FROM mailboxes m LEFT JOIN cloudflare_accounts a ON a.mailbox_id=m.id
      WHERE m.id IN (${placeholders(ids.length)})
    `).all(...ids);
    return new Map(rows.map((row) => [row.id, {
      ...row,
      cloudflare_eligible: row.cloudflare_eligible || (row.cloudflare_status === 'cancelled' && !row.cloudflare_last_error_code) ? 1 : 0,
    }]));
  }

  listEligibleMailboxes(limit = 100, search = '') {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const clean = String(search || '').trim().slice(0, 100);
    const whereSearch = clean ? 'AND (m.email LIKE ? OR m.username LIKE ?)' : '';
    const args = clean ? [`%${clean}%`, `%${clean}%`, safeLimit] : [safeLimit];
    return this.db.prepare(`
      SELECT m.id, m.email, m.username, 1 AS cloudflare_eligible
      FROM mailboxes m LEFT JOIN cloudflare_accounts a ON a.mailbox_id=m.id
      WHERE m.status='active' AND (a.id IS NULL OR (a.status='cancelled' AND a.last_error_code IS NULL)) ${whereSearch}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(...args);
  }

  stats() {
    const statusRows = this.db.prepare('SELECT status, COUNT(*) AS count FROM cloudflare_accounts GROUP BY status').all();
    const accounts = {};
    for (const row of statusRows) accounts[row.status] = Number(row.count);
    const activeJobRow = this.db.prepare(`
      SELECT id FROM cloudflare_jobs WHERE status IN ('running','paused','needs_action') ORDER BY created_at DESC LIMIT 1
    `).get();
    return {
      totalAccounts: Object.values(accounts).reduce((sum, count) => sum + count, 0),
      verifiedAccounts: Number(accounts.verified || 0),
      needsActionAccounts: Number(accounts.needs_action || 0),
      accounts,
      activeJob: activeJobRow ? this.getJob(activeJobRow.id) : null,
    };
  }

  getPasswordRecord(jobId) {
    return this.db.prepare(`SELECT id, password_mode, password_ciphertext FROM cloudflare_jobs WHERE id=?`).get(String(jobId || '')) || null;
  }

  getAccountPasswordRecord(accountId) {
    return this.db.prepare(`
      SELECT a.id AS account_id, a.email, a.credential_job_id AS job_id, j.password_ciphertext
      FROM cloudflare_accounts a JOIN cloudflare_jobs j ON j.id=a.credential_job_id WHERE a.id=?
    `).get(String(accountId || '')) || null;
  }

  setJobStatus(id, status) {
    if (!JOB_STATUSES.has(status)) throw exposedError('Invalid Cloudflare job status');
    const now = nowIso();
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    const result = terminal
      ? this.db.prepare('UPDATE cloudflare_jobs SET status=?, updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE id=?').run(status, now, now, id)
      : this.db.prepare('UPDATE cloudflare_jobs SET status=?, updated_at=?, completed_at=NULL WHERE id=?').run(status, now, id);
    return result.changes > 0;
  }

  cancelJob(id) {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='cancelled', phase='cancelled',
          phase_message=CASE WHEN submitted_at IS NULL THEN 'Cancelled before submission' ELSE 'Cancelled; an external account may already exist' END,
          last_error_code=CASE WHEN submitted_at IS NULL THEN NULL ELSE 'cancelled_external_state_unknown' END,
          browser_state_ciphertext=NULL, verification_url_ciphertext=NULL,
          leased_runner_id=NULL, lease_expires_at=NULL, finished_at=?, updated_at=?
        WHERE job_id=? AND status NOT IN ('verified','failed','cancelled')
      `).run(now, now, id);
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='cancelled',
          last_error_code=CASE WHEN EXISTS(
            SELECT 1 FROM cloudflare_job_items i WHERE i.account_id=cloudflare_accounts.id AND i.job_id=? AND i.submitted_at IS NOT NULL
          ) THEN 'cancelled_external_state_unknown' ELSE NULL END,
          last_error=CASE WHEN EXISTS(
            SELECT 1 FROM cloudflare_job_items i WHERE i.account_id=cloudflare_accounts.id AND i.job_id=? AND i.submitted_at IS NOT NULL
          ) THEN 'Cancelled after signup submission; an external Cloudflare account may exist' ELSE NULL END,
          updated_at=?
        WHERE credential_job_id=? AND status<>'verified'
      `).run(id, id, now, id);
      this.db.prepare(`UPDATE cloudflare_jobs SET status='cancelled', completed_at=?, updated_at=? WHERE id=?`).run(now, now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pauseJob(id) {
    const job = this.getJob(id);
    if (!job) return false;
    const active = job.items.find((item) => ['preparing', 'creating', 'awaiting_submit', 'verifying'].includes(item.status));
    if (active && ['creating', 'awaiting_submit'].includes(active.status)) {
      this.markNeedsAction(active.id, 'paused_submit_unknown', 'Browser task was paused near signup; reconcile before retrying');
      return true;
    }
    const now = nowIso();
    if (active?.status === 'preparing') {
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='queued', phase='queued', phase_message='Paused before browser submission',
          attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END, leased_runner_id=NULL,
          lease_expires_at=NULL, next_attempt_at=?, updated_at=? WHERE id=?
      `).run(now, now, active.id);
    }
    if (active?.status === 'verifying') {
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='waiting_for_verification', phase='waiting_for_verification',
          phase_message='Verification paused by operator', leased_runner_id=NULL, lease_expires_at=NULL,
          next_attempt_at=?, updated_at=? WHERE id=?
      `).run(now, now, active.id);
    }
    return this.setJobStatus(id, 'paused');
  }

  activeItem() {
    return this.db.prepare(`
      SELECT ${publicItemColumns('i')}, m.username FROM cloudflare_job_items i
      JOIN mailboxes m ON m.id=i.mailbox_id
      WHERE i.status IN (${ACTIVE_ITEM_STATUSES.map(() => '?').join(',')})
      ORDER BY i.updated_at LIMIT 1
    `).get(...ACTIVE_ITEM_STATUSES) || null;
  }

  beginNextSignup() {
    if (this.activeItem()) return null;
    const now = nowIso();
    const candidate = this.db.prepare(`
      SELECT i.id FROM cloudflare_job_items i JOIN cloudflare_jobs j ON j.id=i.job_id
      WHERE j.status='running' AND i.status IN ('queued','retry_waiting') AND i.next_attempt_at<=?
      ORDER BY j.created_at, i.position LIMIT 1
    `).get(now);
    if (!candidate) return null;
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='preparing', phase='preparing',
        phase_message='Waiting for the paired browser runner', attempts=attempts+1,
        attempt_started_at=COALESCE(attempt_started_at, ?), finished_at=NULL, updated_at=? WHERE id=?
    `).run(now, now, candidate.id);
    this.db.prepare(`
      UPDATE cloudflare_jobs SET started_at=COALESCE(started_at, ?), updated_at=?
      WHERE id=(SELECT job_id FROM cloudflare_job_items WHERE id=?)
    `).run(now, now, candidate.id);
    return this.getItem(candidate.id);
  }

  getItem(id, { includeSecrets = false } = {}) {
    const secretColumns = includeSecrets
      ? ', j.password_ciphertext, i.browser_state_ciphertext, i.verification_url_ciphertext'
      : '';
    return this.db.prepare(`
      SELECT ${publicItemColumns('i')}, m.username, a.cloudflare_account_id,
             j.password_mode${secretColumns}
      FROM cloudflare_job_items i
      JOIN cloudflare_jobs j ON j.id=i.job_id
      JOIN cloudflare_accounts a ON a.id=i.account_id
      JOIN mailboxes m ON m.id=i.mailbox_id
      WHERE i.id=?
    `).get(String(id || '')) || null;
  }

  setArtifact(id, artifactName) {
    const safe = String(artifactName || '');
    if (!/^cf-artifact-[a-zA-Z0-9_-]+-[0-9]+\.enc$/.test(safe)) throw new Error('Invalid Cloudflare artifact name');
    this.db.prepare('UPDATE cloudflare_job_items SET artifact_name=?, updated_at=? WHERE id=?').run(safe, nowIso(), id);
  }

  getArtifactRecord(id) {
    return this.db.prepare('SELECT id, artifact_name FROM cloudflare_job_items WHERE id=?').get(String(id || '')) || null;
  }

  dueVerificationItem() {
    return this.db.prepare(`
      SELECT ${publicItemColumns('i')}, m.username
      FROM cloudflare_job_items i
      JOIN cloudflare_jobs j ON j.id=i.job_id
      JOIN mailboxes m ON m.id=i.mailbox_id
      WHERE j.status='running' AND i.status='waiting_for_verification' AND i.next_attempt_at<=?
      ORDER BY i.submitted_at LIMIT 1
    `).get(nowIso()) || null;
  }

  scheduleVerificationPoll(id, delayMs, message = 'Waiting for the Cloudflare verification email') {
    const now = new Date();
    const next = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 15000)).toISOString();
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='waiting_for_verification', phase='waiting_for_verification',
        phase_message=?, next_attempt_at=?, last_inbox_check_at=?, updated_at=?
      WHERE id=? AND status='waiting_for_verification'
    `).run(cleanMessage(message), next, now.toISOString(), now.toISOString(), id);
  }

  markVerificationFound(id, verificationUrlCiphertext, receivedAt) {
    const now = nowIso();
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='verifying', phase='verifying',
        phase_message='Safe Cloudflare verification link found; waiting for browser runner',
        verification_url_ciphertext=?, verification_received_at=?, next_attempt_at=?,
        leased_runner_id=NULL, lease_expires_at=NULL, updated_at=?
      WHERE id=? AND status='waiting_for_verification'
    `).run(verificationUrlCiphertext, receivedAt || now, now, now, id);
    const item = this.db.prepare('SELECT job_id, account_id FROM cloudflare_job_items WHERE id=?').get(id);
    if (item) {
      this.db.prepare(`UPDATE cloudflare_accounts SET status='verifying', last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?`).run(now, item.account_id);
      this.refreshJob(item.job_id);
    }
  }

  claimRunnerTask(runnerId, leaseMs = 60000) {
    const now = new Date();
    const expires = new Date(now.getTime() + Math.max(15000, Number(leaseMs) || 60000)).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT id, lease_generation FROM cloudflare_job_items
        WHERE status IN ('preparing','verifying')
          AND (leased_runner_id IS NULL OR lease_expires_at<=?)
        ORDER BY updated_at LIMIT 1
      `).get(now.toISOString());
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const generation = Number(row.lease_generation || 0) + 1;
      this.db.prepare(`
        UPDATE cloudflare_job_items SET leased_runner_id=?, lease_generation=?, lease_expires_at=?,
          status=CASE WHEN status='preparing' THEN 'creating' ELSE status END,
          phase=CASE WHEN status='preparing' AND phase<>'reconciling' THEN 'opening_signup' ELSE phase END,
          phase_message=CASE
            WHEN status='preparing' AND phase='reconciling' THEN 'Browser runner is reconciling the existing Cloudflare account'
            WHEN status='preparing' THEN 'Browser runner is opening Cloudflare signup'
            ELSE phase_message END,
          updated_at=? WHERE id=?
      `).run(runnerId, generation, expires, now.toISOString(), row.id);
      this.db.exec('COMMIT');
      return this.getItem(row.id, { includeSecrets: true });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  validateLease(id, runnerId, generation) {
    const item = this.db.prepare(`
      SELECT id, status, leased_runner_id, lease_generation, lease_expires_at
      FROM cloudflare_job_items WHERE id=?
    `).get(String(id || ''));
    return Boolean(item
      && item.leased_runner_id === runnerId
      && Number(item.lease_generation) === Number(generation)
      && Date.parse(item.lease_expires_at || '') > Date.now()
      && !TERMINAL_ITEM_STATUSES.has(item.status));
  }

  renewLease(id, runnerId, generation, leaseMs = 60000) {
    const expires = new Date(Date.now() + Math.max(15000, Number(leaseMs) || 60000)).toISOString();
    const result = this.db.prepare(`
      UPDATE cloudflare_job_items SET lease_expires_at=?, updated_at=?
      WHERE id=? AND leased_runner_id=? AND lease_generation=?
        AND status NOT IN ('verified','failed','cancelled')
    `).run(expires, nowIso(), id, runnerId, Number(generation));
    return result.changes > 0;
  }

  updateProgress(id, runnerId, generation, phase, message) {
    if (!this.validateLease(id, runnerId, generation)) return false;
    const result = this.db.prepare(`
      UPDATE cloudflare_job_items SET phase=?, phase_message=?, updated_at=? WHERE id=?
    `).run(cleanMessage(phase, 'working').slice(0, 64), cleanMessage(message, 'Cloudflare browser task is running'), nowIso(), id);
    return result.changes > 0;
  }

  markAwaitingSubmit(id, runnerId, generation, browserStateCiphertext = null) {
    if (!this.validateLease(id, runnerId, generation)) return false;
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE cloudflare_job_items SET status='awaiting_submit', phase='awaiting_submit',
        phase_message='Form is ready; submit it in the visible Chromium window',
        browser_state_ciphertext=COALESCE(?, browser_state_ciphertext), updated_at=? WHERE id=?
    `).run(browserStateCiphertext, now, id);
    this.db.prepare(`UPDATE cloudflare_accounts SET status='awaiting_submit', updated_at=? WHERE id=(SELECT account_id FROM cloudflare_job_items WHERE id=?)`).run(now, id);
    return result.changes > 0;
  }

  markSubmitted(id, runnerId, generation, browserStateCiphertext = null, {
    resetSubmittedAt = false,
    evidence = 'browser_confirmed',
  } = {}) {
    if (!this.validateLease(id, runnerId, generation)) return false;
    const safeEvidence = String(evidence || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
    if (!safeEvidence) return false;
    const now = nowIso();
    const item = this.db.prepare('SELECT job_id FROM cloudflare_job_items WHERE id=?').get(id);
    const result = this.db.prepare(`
      UPDATE cloudflare_job_items SET status='waiting_for_verification', phase='waiting_for_verification',
        phase_message='Cloudflare accepted signup; waiting for the verification email',
        submitted_at=CASE WHEN ? THEN ? ELSE COALESCE(submitted_at, ?) END,
        signup_acceptance_evidence=?, verification_wait_started_at=?, last_inbox_check_at=NULL,
        browser_state_ciphertext=COALESCE(?, browser_state_ciphertext), next_attempt_at=?,
        leased_runner_id=NULL, lease_expires_at=NULL, last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
    `).run(resetSubmittedAt ? 1 : 0, now, now, safeEvidence, now, browserStateCiphertext, now, now, id);
    this.db.prepare(`UPDATE cloudflare_accounts SET status='waiting_for_verification', last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=(SELECT account_id FROM cloudflare_job_items WHERE id=?)`).run(now, id);
    if (item) this.refreshJob(item.job_id);
    return result.changes > 0;
  }

  markNeedsAction(id, code, message, { preserveLease = false } = {}) {
    const now = nowIso();
    const item = this.db.prepare('SELECT job_id, account_id FROM cloudflare_job_items WHERE id=?').get(id);
    if (!item) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='needs_action', phase='needs_action', phase_message=?,
          last_error_code=?, last_error=?, leased_runner_id=CASE WHEN ? THEN leased_runner_id ELSE NULL END,
          lease_expires_at=CASE WHEN ? THEN lease_expires_at ELSE NULL END, updated_at=? WHERE id=?
      `).run(cleanMessage(message, 'Operator action is required'), cleanMessage(code, 'needs_action').slice(0, 80),
        cleanMessage(message, 'Operator action is required'), preserveLease ? 1 : 0, preserveLease ? 1 : 0, now, id);
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='needs_action', last_error_code=?, last_error=?, updated_at=? WHERE id=?
      `).run(cleanMessage(code, 'needs_action').slice(0, 80), cleanMessage(message, 'Operator action is required'), now, item.account_id);
      this.db.prepare(`UPDATE cloudflare_jobs SET status='needs_action', last_error_code=?, last_error=?, updated_at=? WHERE id=?`)
        .run(cleanMessage(code, 'needs_action').slice(0, 80), cleanMessage(message, 'Operator action is required'), now, item.job_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.refreshJob(item.job_id);
    return true;
  }

  rescheduleItem(id, delayMs, code, message) {
    const item = this.db.prepare('SELECT job_id, account_id FROM cloudflare_job_items WHERE id=?').get(id);
    if (!item) return false;
    const now = new Date();
    const next = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 15000)).toISOString();
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='retry_waiting', phase='retry_waiting', phase_message=?,
        last_error_code=?, last_error=?, next_attempt_at=?, leased_runner_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?
    `).run(cleanMessage(message), cleanMessage(code).slice(0, 80), cleanMessage(message), next, now.toISOString(), id);
    this.db.prepare(`UPDATE cloudflare_accounts SET status='retry_waiting', last_error_code=?, last_error=?, updated_at=? WHERE id=?`)
      .run(cleanMessage(code).slice(0, 80), cleanMessage(message), now.toISOString(), item.account_id);
    this.refreshJob(item.job_id);
    return true;
  }

  markFailed(id, code, message) {
    const item = this.db.prepare('SELECT job_id, account_id FROM cloudflare_job_items WHERE id=?').get(id);
    if (!item) return false;
    const now = nowIso();
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='failed', phase='failed', phase_message=?, last_error_code=?,
        last_error=?, browser_state_ciphertext=NULL, verification_url_ciphertext=NULL,
        leased_runner_id=NULL, lease_expires_at=NULL, finished_at=?, updated_at=? WHERE id=?
    `).run(cleanMessage(message), cleanMessage(code).slice(0, 80), cleanMessage(message), now, now, id);
    this.db.prepare(`UPDATE cloudflare_accounts SET status='failed', last_error_code=?, last_error=?, updated_at=? WHERE id=?`)
      .run(cleanMessage(code).slice(0, 80), cleanMessage(message), now, item.account_id);
    this.refreshJob(item.job_id);
    return true;
  }

  markVerified(id, runnerId, generation, cloudflareAccountId = null) {
    if (!this.validateLease(id, runnerId, generation)) return false;
    const item = this.db.prepare('SELECT job_id, account_id FROM cloudflare_job_items WHERE id=?').get(id);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='verified', phase='verified', phase_message='Cloudflare email is verified',
          verified_at=?, finished_at=?, browser_state_ciphertext=NULL, verification_url_ciphertext=NULL,
          leased_runner_id=NULL, lease_expires_at=NULL, last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
      `).run(now, now, now, id);
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='verified', cloudflare_account_id=COALESCE(?, cloudflare_account_id),
          verified_at=?, last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
      `).run(cloudflareAccountId ? String(cloudflareAccountId).slice(0, 128) : null, now, now, item.account_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.refreshJob(item.job_id);
    return true;
  }

  retryItem(id) {
    const item = this.db.prepare('SELECT * FROM cloudflare_job_items WHERE id=?').get(String(id || ''));
    if (!item) throw exposedError('Cloudflare job item not found', 404, 'cloudflare_item_not_found');
    if (!['needs_action', 'failed', 'retry_waiting'].includes(item.status)) {
      throw exposedError(`Cloudflare item cannot be retried from ${item.status}`, 409, 'invalid_cloudflare_state');
    }
    if (UNCERTAIN_SIGNUP_CODES.has(String(item.last_error_code || ''))) {
      throw exposedError('This item requires existing-account reconciliation before any new signup attempt', 409, 'reconcile_required');
    }
    const now = nowIso();
    const nextStatus = item.submitted_at ? 'waiting_for_verification' : 'queued';
    const phaseMessage = item.submitted_at
      ? 'Checking again for the existing signup verification email'
      : 'Queued for another browser attempt';
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status=?, phase=?, phase_message=?, next_attempt_at=?,
        verification_wait_started_at=CASE WHEN submitted_at IS NOT NULL THEN ? ELSE verification_wait_started_at END,
        last_error_code=NULL, last_error=NULL, leased_runner_id=NULL, lease_expires_at=NULL,
        finished_at=NULL, updated_at=? WHERE id=?
    `).run(nextStatus, nextStatus, phaseMessage, now, now, now, item.id);
    this.db.prepare(`UPDATE cloudflare_accounts SET status=?, last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?`)
      .run(nextStatus, now, item.account_id);
    this.db.prepare(`UPDATE cloudflare_jobs SET status='running', last_error_code=NULL, last_error=NULL, completed_at=NULL, updated_at=? WHERE id=?`)
      .run(now, item.job_id);
    this.refreshJob(item.job_id);
    return this.getItem(item.id);
  }

  reconcileItem(id) {
    const item = this.db.prepare('SELECT * FROM cloudflare_job_items WHERE id=?').get(String(id || ''));
    if (!item) throw exposedError('Cloudflare job item not found', 404, 'cloudflare_item_not_found');
    if (!['needs_action', 'failed', 'retry_waiting'].includes(item.status)) {
      throw exposedError(`Cloudflare item cannot be reconciled from ${item.status}`, 409, 'invalid_cloudflare_state');
    }
    const now = nowIso();
    this.db.prepare(`
      UPDATE cloudflare_job_items SET status='preparing', phase='reconciling',
        phase_message='Waiting for the browser runner to log in and inspect the existing account',
        next_attempt_at=?, attempts=attempts+1, attempt_started_at=?, finished_at=NULL,
        last_error_code=NULL, last_error=NULL, leased_runner_id=NULL, lease_expires_at=NULL,
        updated_at=? WHERE id=?
    `).run(now, now, now, item.id);
    this.db.prepare(`
      UPDATE cloudflare_accounts SET status='preparing', last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
    `).run(now, item.account_id);
    this.db.prepare(`
      UPDATE cloudflare_jobs SET status='running', last_error_code=NULL, last_error=NULL,
        completed_at=NULL, started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?
    `).run(now, now, item.job_id);
    this.refreshJob(item.job_id);
    return this.getItem(item.id);
  }

  releaseExpiredLease() {
    const item = this.db.prepare(`
      SELECT id, status FROM cloudflare_job_items
      WHERE leased_runner_id IS NOT NULL AND lease_expires_at<=? AND status NOT IN ('verified','failed','cancelled')
      ORDER BY lease_expires_at LIMIT 1
    `).get(nowIso());
    if (!item) return null;
    if (item.status === 'verifying') {
      const now = nowIso();
      this.db.prepare(`
        UPDATE cloudflare_job_items SET status='waiting_for_verification', phase='waiting_for_verification',
          phase_message='Verification runner disconnected; safe to resume', leased_runner_id=NULL,
          lease_expires_at=NULL, next_attempt_at=?, updated_at=? WHERE id=?
      `).run(now, now, item.id);
    } else if (item.status === 'creating') {
      this.markNeedsAction(item.id, 'runner_disconnected_uncertain', 'Runner disconnected near signup; reconcile before retrying');
    } else {
      this.db.prepare('UPDATE cloudflare_job_items SET leased_runner_id=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?')
        .run(nowIso(), item.id);
    }
    return this.getItem(item.id);
  }

  refreshJob(jobId) {
    const now = nowIso();
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified_count,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status='needs_action' THEN 1 ELSE 0 END) AS needs_action_count,
        SUM(CASE WHEN status NOT IN ('verified','failed','cancelled') THEN 1 ELSE 0 END) AS remaining_count
      FROM cloudflare_job_items WHERE job_id=?
    `).get(jobId);
    const job = this.db.prepare('SELECT status FROM cloudflare_jobs WHERE id=?').get(jobId);
    if (!job) return;
    let status = job.status;
    if (status !== 'cancelled') {
      if (Number(counts.needs_action_count || 0) > 0) status = 'needs_action';
      else if (Number(counts.remaining_count || 0) === 0) status = Number(counts.failed_count || 0) > 0 ? 'failed' : 'completed';
      else if (status !== 'paused') status = 'running';
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    this.db.prepare(`
      UPDATE cloudflare_jobs SET status=?, verified_count=?, failed_count=?, needs_action_count=?,
        updated_at=?, completed_at=CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id=?
    `).run(status, Number(counts.verified_count || 0), Number(counts.failed_count || 0),
      Number(counts.needs_action_count || 0), now, terminal ? 1 : 0, now, jobId);
  }
}
