import crypto from 'node:crypto';
import { isCloudflareVerificationUrl } from './cloudflare-verification.js';
import { newId, nowIso } from './utils.js';

export const CLOUDFLARE_MANUAL_STATUSES = new Set([
  'not_started',
  'signup_done',
  'waiting_verification',
  'verification_received',
  'verified',
  'failed',
]);

const PASSWORD_GROUPS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  '!@#$%^&*_-+=?',
];
const PASSWORD_ALPHABET = PASSWORD_GROUPS.join('');

function exposedError(message, statusCode = 400, code = 'invalid_cloudflare_request') {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function safeSignupUrl(value) {
  try {
    const parsed = new URL(String(value || 'https://dash.cloudflare.com/sign-up'));
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.protocol === 'https:' && (host === 'cloudflare.com' || host.endsWith('.cloudflare.com'))) {
      return parsed.toString();
    }
  } catch {}
  return 'https://dash.cloudflare.com/sign-up';
}

function shuffleSecure(characters) {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other], characters[index]];
  }
  return characters;
}

export function generateCloudflareAccountPassword(length = 20) {
  const safeLength = Number(length);
  if (!Number.isInteger(safeLength) || safeLength < PASSWORD_GROUPS.length || safeLength > 128) {
    throw new TypeError('Cloudflare password length must be an integer between 4 and 128');
  }
  // Keep the first character alphabetic so an exact password remains safe in
  // spreadsheet CSV consumers without formula-escaping changing its value.
  const first = PASSWORD_GROUPS[0][crypto.randomInt(PASSWORD_GROUPS[0].length)];
  const characters = PASSWORD_GROUPS.slice(1).map((group) => group[crypto.randomInt(group.length)]);
  while (characters.length < safeLength - 1) {
    characters.push(PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]);
  }
  return `${first}${shuffleSecure(characters).join('')}`;
}

function normalizeLegacyStatus(account, item) {
  if (account.status === 'verified' || item?.status === 'verified') return 'verified';
  if (item?.verification_url_ciphertext || item?.verification_received_at) return 'verification_received';
  if (item?.submitted_at || ['waiting_for_verification', 'verifying'].includes(item?.status)) return 'waiting_verification';
  if (['failed', 'needs_action', 'cancelled'].includes(account.status)
      || ['failed', 'needs_action', 'cancelled'].includes(item?.status)) return 'failed';
  return 'not_started';
}

function publicAccountColumns(alias = 'a') {
  return `${alias}.id, ${alias}.mailbox_id, ${alias}.email, ${alias}.credential_job_id AS job_id,
          ${alias}.status, ${alias}.notes, ${alias}.created_at, ${alias}.updated_at,
          ${alias}.signup_done_at, ${alias}.verification_received_at, ${alias}.verified_at,
          ${alias}.last_inbox_check_at, ${alias}.failed_at, ${alias}.password_locked_at,
          ${alias}.last_error_code, ${alias}.last_error,
          ${alias}.password_ciphertext IS NOT NULL AS has_password,
          ${alias}.verification_url_ciphertext IS NOT NULL AS has_verification_link`;
}

export class CloudflareManualService {
  constructor({ store, vault, mailClient = null, backupManager = null, config = {} }) {
    if (!store?.db) throw new Error('CloudflareManualService requires the primary SQLite store');
    if (!vault?.sealCloudflareSecret || !vault?.openCloudflareSecret) {
      throw new Error('CloudflareManualService requires the encrypted credential vault');
    }
    this.store = store;
    this.db = store.db;
    this.vault = vault;
    this.mailClient = mailClient;
    this.backupManager = backupManager;
    this.config = config;
  }

  initialize() {
    const rows = this.db.prepare(`
      SELECT a.*, j.password_ciphertext AS legacy_password_ciphertext,
             i.id AS item_id, i.status AS item_status, i.submitted_at AS item_submitted_at,
             i.verification_received_at AS item_verification_received_at,
             i.verification_url_ciphertext AS item_verification_url_ciphertext
      FROM cloudflare_accounts a
      JOIN cloudflare_jobs j ON j.id=a.credential_job_id
      LEFT JOIN cloudflare_job_items i ON i.account_id=a.id AND i.job_id=a.credential_job_id
      WHERE a.workflow_mode<>'manual' OR a.password_ciphertext IS NULL
      ORDER BY a.created_at, i.position
    `).all();
    if (!rows.length) return { migrated: 0, legacyCredentialsPreserved: 0, failures: 0 };

    let migrated = 0;
    let legacyCredentialsPreserved = 0;
    let failures = 0;
    const now = nowIso();
    const seenPasswords = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const item = {
          status: row.item_status,
          submitted_at: row.item_submitted_at,
          verification_received_at: row.item_verification_received_at,
          verification_url_ciphertext: row.item_verification_url_ciphertext,
        };
        let status = normalizeLegacyStatus(row, item);
        let passwordCiphertext = row.password_ciphertext;
        let lastErrorCode = row.last_error_code;
        let lastError = row.last_error;
        if (!passwordCiphertext) {
          try {
            let password;
            if (status === 'not_started') {
              do { password = generateCloudflareAccountPassword(); } while (seenPasswords.has(password));
            } else {
              password = this.vault.openCloudflareSecret(row.legacy_password_ciphertext, {
                purpose: 'cloudflare-job-password', id: row.credential_job_id,
              });
              legacyCredentialsPreserved += 1;
            }
            seenPasswords.add(password);
            passwordCiphertext = this.vault.sealCloudflareSecret(password, {
              purpose: 'cloudflare-account-password', id: row.id,
            });
          } catch {
            status = 'failed';
            lastErrorCode = 'legacy_password_unavailable';
            lastError = 'The legacy Cloudflare credential could not be migrated with the active encryption key';
            failures += 1;
          }
        }

        let verificationCiphertext = row.verification_url_ciphertext;
        if (!verificationCiphertext && row.item_verification_url_ciphertext && row.item_id) {
          try {
            const url = this.vault.openCloudflareSecret(row.item_verification_url_ciphertext, {
              purpose: 'cloudflare-verification-url', id: row.item_id,
            });
            if (isCloudflareVerificationUrl(url)) {
              verificationCiphertext = this.vault.sealCloudflareSecret(url, {
                purpose: 'cloudflare-account-verification-url', id: row.id,
              });
            }
          } catch {
            verificationCiphertext = null;
            if (status === 'verification_received') status = 'waiting_verification';
          }
        }

        const signupDoneAt = row.signup_done_at || row.item_submitted_at || null;
        const verificationReceivedAt = row.verification_received_at || row.item_verification_received_at || null;
        const lockedAt = status === 'not_started' ? null : (row.password_locked_at || signupDoneAt || now);
        this.db.prepare(`
          UPDATE cloudflare_accounts
          SET workflow_mode='manual', status=?, password_ciphertext=?, notes=COALESCE(notes, ''),
              signup_done_at=?, verification_received_at=?, verification_url_ciphertext=?,
              password_locked_at=?, failed_at=CASE WHEN ?='failed' THEN COALESCE(failed_at, ?) ELSE failed_at END,
              last_error_code=?, last_error=?, updated_at=?
          WHERE id=?
        `).run(
          status, passwordCiphertext, signupDoneAt, verificationReceivedAt, verificationCiphertext,
          lockedAt, status, now, lastErrorCode, lastError, now, row.id,
        );
        if (row.item_id) {
          this.db.prepare(`
            UPDATE cloudflare_job_items
            SET status=?, phase=?, phase_message='Imported into the manual Cloudflare assistant',
                submitted_at=COALESCE(submitted_at, ?), verification_received_at=COALESCE(verification_received_at, ?),
                leased_runner_id=NULL, lease_expires_at=NULL, browser_state_ciphertext=NULL, updated_at=?
            WHERE id=?
          `).run(status, status, signupDoneAt, verificationReceivedAt, now, row.item_id);
        }
        migrated += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.store.audit('info', 'cloudflare.manual_migration', `Migrated ${migrated} Cloudflare account record(s) to the manual assistant`);
    this.backupManager?.requestBackup?.('cloudflare-manual-migration');
    return { migrated, legacyCredentialsPreserved, failures };
  }

  createBatch(mailboxIds) {
    if (!Array.isArray(mailboxIds) || mailboxIds.length < 1 || mailboxIds.length > Number(this.config.cloudflareMaxBatchSize || 100)) {
      throw exposedError(`Select between 1 and ${Number(this.config.cloudflareMaxBatchSize || 100)} mailboxes`);
    }
    const ids = mailboxIds.map((value) => String(value || '').trim()).filter(Boolean);
    if (ids.length !== mailboxIds.length || new Set(ids).size !== ids.length) {
      throw exposedError('Mailbox selection contains invalid or duplicate entries');
    }
    const mailboxes = this.db.prepare(`
      SELECT id, username, email, status FROM mailboxes WHERE id IN (${placeholders(ids.length)})
    `).all(...ids);
    if (mailboxes.length !== ids.length) throw exposedError('One or more selected mailboxes do not exist', 404, 'mailbox_not_found');
    const byId = new Map(mailboxes.map((row) => [row.id, row]));
    const inactive = mailboxes.find((row) => row.status !== 'active');
    if (inactive) throw exposedError('One or more selected mailboxes are inactive', 409, 'mailbox_inactive');
    const duplicate = this.db.prepare(`
      SELECT email, status, verified_at FROM cloudflare_accounts
      WHERE mailbox_id IN (${placeholders(ids.length)}) LIMIT 1
    `).get(...ids);
    if (duplicate) {
      const detail = duplicate.verified_at ? `, verified on ${duplicate.verified_at}` : ` (${duplicate.status})`;
      throw exposedError(`${duplicate.email} is already used for Cloudflare${detail}`, 409, 'cloudflare_account_tracked');
    }

    const jobId = newId('cfjob');
    const now = nowIso();
    const generated = new Set();
    const accounts = ids.map((mailboxId, index) => {
      let password;
      do { password = generateCloudflareAccountPassword(20); } while (generated.has(password));
      generated.add(password);
      const accountId = newId('cfacct');
      return {
        mailbox: byId.get(mailboxId),
        accountId,
        itemId: newId('cfitem'),
        position: index + 1,
        passwordCiphertext: this.vault.sealCloudflareSecret(password, {
          purpose: 'cloudflare-account-password', id: accountId,
        }),
      };
    });
    const batchMarker = this.vault.sealCloudflareSecret('manual-assistant-v1', {
      purpose: 'cloudflare-job-password', id: jobId,
    });

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO cloudflare_jobs(
          id, requested_count, password_mode, password_ciphertext, status, created_at, updated_at
        ) VALUES(?, ?, 'per_account_generated', ?, 'running', ?, ?)
      `).run(jobId, accounts.length, batchMarker, now, now);
      const insertAccount = this.db.prepare(`
        INSERT INTO cloudflare_accounts(
          id, mailbox_id, email, credential_job_id, status, password_ciphertext,
          notes, workflow_mode, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'not_started', ?, '', 'manual', ?, ?)
      `);
      const insertItem = this.db.prepare(`
        INSERT INTO cloudflare_job_items(
          id, job_id, account_id, mailbox_id, position, email, status, phase,
          phase_message, next_attempt_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'not_started', 'not_started',
          'Ready for manual Cloudflare signup', ?, ?, ?)
      `);
      for (const account of accounts) {
        insertAccount.run(
          account.accountId, account.mailbox.id, account.mailbox.email, jobId,
          account.passwordCiphertext, now, now,
        );
        insertItem.run(
          account.itemId, jobId, account.accountId, account.mailbox.id, account.position,
          account.mailbox.email, now, now, now,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (/UNIQUE constraint/i.test(String(error?.message || ''))) {
        throw exposedError('A selected email is already used for Cloudflare', 409, 'cloudflare_account_tracked');
      }
      throw error;
    }
    this.store.audit('info', 'cloudflare.manual_batch_created', `Created manual Cloudflare batch with ${accounts.length} account(s)`, jobId);
    this.backupManager?.requestBackup?.('cloudflare-manual-batch-created');
    return { id: jobId, requested_count: accounts.length, created_at: now, focus: this.getFocusAccount() };
  }

  accountSelect(where = '', args = [], suffix = '') {
    return this.db.prepare(`
      SELECT ${publicAccountColumns('a')}, m.username,
             COALESCE(i.position, 1) AS position, j.requested_count AS batch_total
      FROM cloudflare_accounts a
      JOIN mailboxes m ON m.id=a.mailbox_id
      JOIN cloudflare_jobs j ON j.id=a.credential_job_id
      LEFT JOIN cloudflare_job_items i ON i.account_id=a.id AND i.job_id=a.credential_job_id
      ${where} ${suffix}
    `).all(...args);
  }

  getAccount(id) {
    return this.accountSelect('WHERE a.id=?', [String(id || '')], 'LIMIT 1')[0] || null;
  }

  requireAccount(id) {
    const account = this.getAccount(id);
    if (!account) throw exposedError('Cloudflare account record was not found', 404, 'cloudflare_account_not_found');
    return account;
  }

  listAccounts({ status = '', search = '', limit = 100, offset = 0 } = {}) {
    const cleanStatus = String(status || '').trim().toLowerCase();
    if (cleanStatus && !CLOUDFLARE_MANUAL_STATUSES.has(cleanStatus)) throw exposedError('Cloudflare status filter is invalid');
    const cleanSearch = String(search || '').trim().slice(0, 100);
    const conditions = [`a.workflow_mode='manual'`];
    const args = [];
    if (cleanStatus) { conditions.push('a.status=?'); args.push(cleanStatus); }
    if (cleanSearch) { conditions.push('a.email LIKE ?'); args.push(`%${cleanSearch}%`); }
    args.push(
      Math.min(Number(this.config.exportMaxRows || 50000), Math.max(1, Number(limit) || 100)),
      Math.max(0, Number(offset) || 0),
    );
    return this.accountSelect(`WHERE ${conditions.join(' AND ')}`, args, 'ORDER BY a.created_at, i.position LIMIT ? OFFSET ?');
  }

  countAccounts({ status = '', search = '' } = {}) {
    const cleanStatus = String(status || '').trim().toLowerCase();
    const cleanSearch = String(search || '').trim().slice(0, 100);
    const conditions = [`workflow_mode='manual'`];
    const args = [];
    if (cleanStatus) { conditions.push('status=?'); args.push(cleanStatus); }
    if (cleanSearch) { conditions.push('email LIKE ?'); args.push(`%${cleanSearch}%`); }
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM cloudflare_accounts WHERE ${conditions.join(' AND ')}`).get(...args)?.count || 0);
  }

  stats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM cloudflare_accounts
      WHERE workflow_mode='manual' GROUP BY status
    `).all();
    const accounts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const totalAccounts = Object.values(accounts).reduce((total, count) => total + count, 0);
    return {
      mode: 'manual_assistant',
      signupUrl: safeSignupUrl(this.config.cloudflareSignupUrl),
      totalAccounts,
      verifiedAccounts: Number(accounts.verified || 0),
      pendingAccounts: totalAccounts - Number(accounts.verified || 0) - Number(accounts.failed || 0),
      failedAccounts: Number(accounts.failed || 0),
      accounts,
    };
  }

  getFocusAccount() {
    const accounts = this.accountSelect(
      `WHERE a.workflow_mode='manual' AND a.status NOT IN ('verified','failed')`,
      [],
      `ORDER BY CASE a.status
         WHEN 'verification_received' THEN 0
         WHEN 'signup_done' THEN 1
         WHEN 'waiting_verification' THEN 2
         WHEN 'not_started' THEN 3 ELSE 4 END,
       a.created_at, i.position LIMIT 1`,
    );
    const account = accounts[0] || null;
    return { account, stats: this.stats() };
  }

  eligibleMailboxMap(mailboxIds) {
    if (!Array.isArray(mailboxIds) || !mailboxIds.length) return new Map();
    const ids = [...new Set(mailboxIds.map(String))];
    const rows = this.db.prepare(`
      SELECT m.id, CASE WHEN a.id IS NULL THEN 1 ELSE 0 END AS cloudflare_eligible,
             a.status AS cloudflare_status, a.verified_at AS cloudflare_verified_at
      FROM mailboxes m LEFT JOIN cloudflare_accounts a ON a.mailbox_id=m.id
      WHERE m.id IN (${placeholders(ids.length)})
    `).all(...ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  listEligibleMailboxes(limit = 100, search = '') {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const clean = String(search || '').trim().slice(0, 100);
    const searchSql = clean ? 'AND (m.email LIKE ? OR m.username LIKE ?)' : '';
    const args = clean ? [`%${clean}%`, `%${clean}%`, safeLimit] : [safeLimit];
    return this.db.prepare(`
      SELECT m.id, m.email, m.username, 1 AS cloudflare_eligible
      FROM mailboxes m LEFT JOIN cloudflare_accounts a ON a.mailbox_id=m.id
      WHERE m.status='active' AND a.id IS NULL ${searchSql}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(...args);
  }

  revealPassword(id) {
    const account = this.requireAccount(id);
    const row = this.db.prepare('SELECT password_ciphertext FROM cloudflare_accounts WHERE id=?').get(account.id);
    if (!row?.password_ciphertext) throw exposedError('Cloudflare password is unavailable', 409, 'cloudflare_password_unavailable');
    return this.vault.openCloudflareSecret(row.password_ciphertext, {
      purpose: 'cloudflare-account-password', id: account.id,
    });
  }

  regeneratePassword(id) {
    const account = this.requireAccount(id);
    if (account.status !== 'not_started' || account.password_locked_at || account.signup_done_at) {
      throw exposedError('Password regeneration is locked after Signup Done', 409, 'cloudflare_password_locked');
    }
    const password = generateCloudflareAccountPassword(20);
    const ciphertext = this.vault.sealCloudflareSecret(password, {
      purpose: 'cloudflare-account-password', id: account.id,
    });
    const now = nowIso();
    this.db.prepare('UPDATE cloudflare_accounts SET password_ciphertext=?, updated_at=? WHERE id=?')
      .run(ciphertext, now, account.id);
    this.store.audit('warn', 'cloudflare.password_regenerated', 'Cloudflare account password regenerated before signup', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-password-regenerated');
    return { account: this.getAccount(account.id), password };
  }

  syncItem(accountId, status, now, fields = {}) {
    const account = this.requireAccount(accountId);
    this.db.prepare(`
      UPDATE cloudflare_job_items
      SET status=?, phase=?, phase_message=?, submitted_at=COALESCE(?, submitted_at),
          verification_received_at=COALESCE(?, verification_received_at),
          verified_at=COALESCE(?, verified_at), finished_at=CASE WHEN ? IN ('verified','failed') THEN ? ELSE finished_at END,
          updated_at=? WHERE account_id=? AND job_id=?
    `).run(
      status, status, fields.message || 'Manual Cloudflare assistant updated this account',
      fields.signupDoneAt || null, fields.verificationReceivedAt || null, fields.verifiedAt || null,
      status, now, now, accountId, account.job_id,
    );
    this.syncJob(account.job_id, now);
  }

  syncJob(jobId, now = nowIso()) {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status NOT IN ('verified','failed') THEN 1 ELSE 0 END) AS remaining
      FROM cloudflare_accounts WHERE credential_job_id=?
    `).get(jobId);
    const remaining = Number(counts?.remaining || 0);
    const status = remaining > 0 ? 'running' : (Number(counts?.failed || 0) > 0 ? 'failed' : 'completed');
    this.db.prepare(`
      UPDATE cloudflare_jobs SET status=?, verified_count=?, failed_count=?, needs_action_count=0,
        completed_at=CASE WHEN ?='running' THEN NULL ELSE COALESCE(completed_at, ?) END, updated_at=? WHERE id=?
    `).run(status, Number(counts?.verified || 0), Number(counts?.failed || 0), status, now, now, jobId);
  }

  markSignupDone(id) {
    const account = this.requireAccount(id);
    if (account.status !== 'not_started') throw exposedError('Signup Done can only be marked from Not Started', 409, 'invalid_cloudflare_transition');
    const now = nowIso();
    this.db.prepare(`
      UPDATE cloudflare_accounts SET status='signup_done', signup_done_at=?, password_locked_at=?,
        last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
    `).run(now, now, now, account.id);
    this.syncItem(account.id, 'signup_done', now, { signupDoneAt: now, message: 'Operator marked Cloudflare signup complete' });
    this.store.audit('info', 'cloudflare.signup_done', 'Cloudflare signup marked complete by operator', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-signup-done');
    return this.getAccount(account.id);
  }

  async checkInbox(id, { signal = null } = {}) {
    const account = this.requireAccount(id);
    if (!['signup_done', 'waiting_verification', 'verification_received'].includes(account.status) || !account.signup_done_at) {
      throw exposedError('Mark Signup Done before checking this inbox', 409, 'cloudflare_signup_not_done');
    }
    if (!this.mailClient?.findCloudflareVerification) {
      throw exposedError('Atomic Mail inbox service is unavailable', 503, 'mail_unavailable');
    }
    const found = await this.mailClient.findCloudflareVerification(account.username, {
      recipient: account.email,
      submittedAt: account.signup_done_at,
      signal,
      priority: 'interactive',
    });
    const now = nowIso();
    if (!found) {
      this.db.prepare(`
        UPDATE cloudflare_accounts SET status='waiting_verification', last_inbox_check_at=?,
          last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
      `).run(now, now, account.id);
      this.syncItem(account.id, 'waiting_verification', now, { message: 'No trusted Cloudflare verification email found yet' });
      return { found: false, account: this.getAccount(account.id) };
    }
    if (!isCloudflareVerificationUrl(found.url)) {
      throw exposedError('The verification email did not contain a safe Cloudflare HTTPS link', 422, 'unsafe_cloudflare_verification_url');
    }
    const ciphertext = this.vault.sealCloudflareSecret(found.url, {
      purpose: 'cloudflare-account-verification-url', id: account.id,
    });
    const receivedAt = found.receivedAt || now;
    this.db.prepare(`
      UPDATE cloudflare_accounts SET status='verification_received', verification_received_at=?,
        verification_url_ciphertext=?, last_inbox_check_at=?, last_error_code=NULL,
        last_error=NULL, updated_at=? WHERE id=?
    `).run(receivedAt, ciphertext, now, now, account.id);
    this.syncItem(account.id, 'verification_received', now, {
      verificationReceivedAt: receivedAt,
      message: 'Trusted Cloudflare verification email received',
    });
    this.store.audit('info', 'cloudflare.verification_email_found', 'Trusted Cloudflare verification email found', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-verification-received');
    return { found: true, account: this.getAccount(account.id) };
  }

  revealVerificationLink(id) {
    const account = this.requireAccount(id);
    const row = this.db.prepare('SELECT verification_url_ciphertext FROM cloudflare_accounts WHERE id=?').get(account.id);
    if (!row?.verification_url_ciphertext) throw exposedError('Verification link has not been received', 404, 'cloudflare_verification_link_missing');
    const url = this.vault.openCloudflareSecret(row.verification_url_ciphertext, {
      purpose: 'cloudflare-account-verification-url', id: account.id,
    });
    if (!isCloudflareVerificationUrl(url)) throw exposedError('Stored verification link failed the Cloudflare safety check', 409, 'unsafe_cloudflare_verification_url');
    return url;
  }

  markVerified(id) {
    const account = this.requireAccount(id);
    if (account.status !== 'verification_received' || !account.has_verification_link) {
      throw exposedError('A trusted verification email is required before Mark Verified', 409, 'cloudflare_verification_not_received');
    }
    const now = nowIso();
    this.db.prepare(`
      UPDATE cloudflare_accounts SET status='verified', verified_at=?, password_locked_at=COALESCE(password_locked_at, ?),
        last_error_code=NULL, last_error=NULL, updated_at=? WHERE id=?
    `).run(now, now, now, account.id);
    this.syncItem(account.id, 'verified', now, { verifiedAt: now, message: 'Operator confirmed Cloudflare verification' });
    this.store.audit('info', 'cloudflare.verified', 'Cloudflare account marked verified by operator', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-account-verified');
    return { account: this.getAccount(account.id), next: this.getFocusAccount() };
  }

  markFailed(id, reason = '') {
    const account = this.requireAccount(id);
    if (account.status === 'verified') throw exposedError('A verified account cannot be marked failed', 409, 'invalid_cloudflare_transition');
    const now = nowIso();
    const cleanReason = String(reason || '').trim().slice(0, 700) || 'Marked failed by operator';
    this.db.prepare(`
      UPDATE cloudflare_accounts SET status='failed', failed_at=?, password_locked_at=CASE
        WHEN signup_done_at IS NULL THEN password_locked_at ELSE COALESCE(password_locked_at, signup_done_at) END,
        last_error_code='operator_marked_failed', last_error=?, updated_at=? WHERE id=?
    `).run(now, cleanReason, now, account.id);
    this.syncItem(account.id, 'failed', now, { message: 'Operator marked this Cloudflare record failed' });
    this.store.audit('warn', 'cloudflare.failed', 'Cloudflare account marked failed by operator', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-account-failed');
    return { account: this.getAccount(account.id), next: this.getFocusAccount() };
  }

  updateNotes(id, notes) {
    const account = this.requireAccount(id);
    const clean = String(notes ?? '');
    if (Buffer.byteLength(clean, 'utf8') > 8000) throw exposedError('Notes are limited to 8000 UTF-8 bytes', 413, 'cloudflare_notes_too_large');
    const now = nowIso();
    this.db.prepare('UPDATE cloudflare_accounts SET notes=?, updated_at=? WHERE id=?').run(clean, now, account.id);
    this.store.audit('info', 'cloudflare.notes_updated', 'Cloudflare account notes updated', account.job_id);
    this.backupManager?.requestBackup?.('cloudflare-notes-updated');
    return this.getAccount(account.id);
  }

  exportSensitive({ status = '', search = '' } = {}) {
    const accounts = this.listAccounts({ status, search, limit: Number(this.config.exportMaxRows || 50000), offset: 0 });
    return accounts.map((account) => ({
      email: account.email,
      password: this.revealPassword(account.id),
      status: account.status,
    }));
  }
}
