import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

function intEnv(name, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function jsonArrayEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function enumEnv(name, fallback, allowed) {
  const raw = String(process.env[name] || fallback).trim().toLowerCase();
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw;
}

export function loadConfig() {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, process.env.DATA_DIR || './data');
  const secretsDir = path.resolve(cwd, process.env.SECRETS_DIR || './secrets');
  const runtimeScope = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminPassword && adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters when admin authentication is enabled');
  }

  const usernameMinLength = intEnv('USERNAME_MIN_LENGTH', 10, 5, 21);
  const usernameMaxLength = intEnv('USERNAME_MAX_LENGTH', 14, 5, 21);
  if (usernameMinLength > usernameMaxLength) {
    throw new Error('USERNAME_MIN_LENGTH must be less than or equal to USERNAME_MAX_LENGTH');
  }

  return Object.freeze({
    host: process.env.HOST || '127.0.0.1',
    port: intEnv('PORT', 8787, 1, 65535),
    dataDir,
    dbPath: path.resolve(cwd, process.env.DB_PATH || path.join(dataDir, 'atomicmail-panel.sqlite')),
    credentialsRoot: path.join(dataDir, 'credentials'),
    runtimeCredentialsRoot: path.resolve(cwd, process.env.ATOMICMAIL_RUNTIME_DIR || path.join(os.tmpdir(), `atomicmail-panel-runtime-${runtimeScope}`)),
    secretsDir,
    encryptionKeyPath: path.resolve(cwd, process.env.DATA_ENCRYPTION_KEY_FILE || path.join(secretsDir, 'data.key')),
    backupDir: path.resolve(cwd, process.env.BACKUP_DIR || './backups'),
    pidPath: path.join(dataDir, 'panel.pid'),

    autoBackupEnabled: boolEnv('AUTO_BACKUP_ENABLED', true),
    autoBackupIntervalMs: intEnv('AUTO_BACKUP_INTERVAL_MINUTES', 360, 1, 10080) * 60000,
    backupMinGapMs: intEnv('BACKUP_MIN_GAP_MINUTES', 5, 1, 1440) * 60000,
    backupRetention: intEnv('BACKUP_RETENTION', 14, 1, 365),

    maxBatchSize: intEnv('MAX_BATCH_SIZE', 100, 1, 5000),
    usernameMinLength,
    usernameMaxLength,
    exportMaxRows: intEnv('EXPORT_MAX_ROWS', 50000, 1, 200000),

    workerEnabled: boolEnv('WORKER_ENABLED', true),
    workerPollMs: intEnv('WORKER_POLL_MS', 1000, 250, 60000),
    postSuccessDelayMs: intEnv('POST_SUCCESS_DELAY_MS', 5000, 0, 3600000),
    maxRetries: intEnv('MAX_RETRIES', 3, 0, 20),
    retryBaseMs: intEnv('RETRY_BASE_MS', 15000, 1000, 3600000),
    retryMaxMs: intEnv('RETRY_MAX_MS', 300000, 1000, 86400000),
    rateLimitCooldownMs: intEnv('RATE_LIMIT_COOLDOWN_MS', 300000, 1000, 86400000),
    transientCircuitThreshold: intEnv('TRANSIENT_CIRCUIT_THRESHOLD', 5, 1, 100),
    transientCircuitCooldownMs: intEnv('TRANSIENT_CIRCUIT_COOLDOWN_MS', 600000, 1000, 86400000),
    registerTimeoutMs: intEnv('REGISTER_TIMEOUT_MS', 180000, 30000, 1800000),
    shutdownGraceMs: intEnv('SHUTDOWN_GRACE_MS', 15000, 1000, 120000),

    mailCommandTimeoutMs: intEnv('MAIL_COMMAND_TIMEOUT_MS', 60000, 10000, 300000),
    mailInboxLimit: intEnv('MAIL_INBOX_LIMIT', 50, 1, 100),
    mailAutoRefreshSeconds: intEnv('MAIL_AUTO_REFRESH_SECONDS', 45, 30, 300),
    mailMaxBodyBytes: intEnv('MAIL_MAX_BODY_BYTES', 524288, 16384, 2097152),
    mailMaxComposeBytes: intEnv('MAIL_MAX_COMPOSE_BYTES', 204800, 1024, 1048576),
    mailMaxSubjectBytes: intEnv('MAIL_MAX_SUBJECT_BYTES', 2048, 64, 16384),
    mailMaxSearchBytes: intEnv('MAIL_MAX_SEARCH_BYTES', 256, 16, 2048),
    mailMaxAttachmentCount: intEnv('MAIL_MAX_ATTACHMENT_COUNT', 5, 1, 20),
    mailMaxAttachmentBytes: intEnv('MAIL_MAX_ATTACHMENT_BYTES', 5242880, 1024, 26214400),
    mailMaxTotalAttachmentBytes: intEnv('MAIL_MAX_TOTAL_ATTACHMENT_BYTES', 10485760, 1024, 52428800),
    jmapGlobalMinIntervalMs: intEnv('JMAP_GLOBAL_MIN_INTERVAL_MS', 500, 0, 10000),
    jmapMaxRetries: intEnv('JMAP_MAX_RETRIES', 3, 0, 10),
    jmapRetryBaseMs: intEnv('JMAP_RETRY_BASE_MS', 1000, 100, 60000),
    jmapRetryMaxMs: intEnv('JMAP_RETRY_MAX_MS', 30000, 1000, 300000),
    destinationPasswordMaxBytes: intEnv('DESTINATION_PASSWORD_MAX_BYTES', 1024, 32, 8192),

    cloudflareEnabled: boolEnv('CLOUDFLARE_ENABLED', true),
    cloudflareMaxBatchSize: intEnv('CLOUDFLARE_MAX_BATCH_SIZE', 100, 1, 100),
    cloudflareWorkerPollMs: intEnv('CLOUDFLARE_WORKER_POLL_MS', 1000, 250, 60000),
    cloudflareEmailPollMs: intEnv('CLOUDFLARE_EMAIL_POLL_MS', 15000, 5000, 300000),
    cloudflareVerificationTimeoutMs: intEnv('CLOUDFLARE_VERIFICATION_TIMEOUT_MS', 300000, 60000, 86400000),
    cloudflareRunnerLeaseMs: intEnv('CLOUDFLARE_RUNNER_LEASE_MS', 60000, 15000, 300000),
    cloudflareRunnerOfflineMs: intEnv('CLOUDFLARE_RUNNER_OFFLINE_MS', 45000, 10000, 300000),
    cloudflarePairingTtlMs: intEnv('CLOUDFLARE_PAIRING_TTL_MS', 600000, 60000, 3600000),
    cloudflareMaxRetries: intEnv('CLOUDFLARE_MAX_RETRIES', 3, 0, 10),
    cloudflareRetryBaseMs: intEnv('CLOUDFLARE_RETRY_BASE_MS', 15000, 1000, 3600000),
    cloudflareRetryMaxMs: intEnv('CLOUDFLARE_RETRY_MAX_MS', 300000, 1000, 86400000),
    cloudflareRateLimitCooldownMs: intEnv('CLOUDFLARE_RATE_LIMIT_COOLDOWN_MS', 900000, 60000, 86400000),
    cloudflarePostItemDelayMs: intEnv('CLOUDFLARE_POST_ITEM_DELAY_MS', 30000, 0, 3600000),
    cloudflareSignupUrl: process.env.CLOUDFLARE_SIGNUP_URL || 'https://dash.cloudflare.com/sign-up',
    cloudflareLoginUrl: process.env.CLOUDFLARE_LOGIN_URL || 'https://dash.cloudflare.com/login',
    cloudflareArtifactDir: path.resolve(cwd, process.env.CLOUDFLARE_ARTIFACT_DIR || path.join(dataDir, 'cloudflare-artifacts')),
    cloudflareArtifactRetentionDays: intEnv('CLOUDFLARE_ARTIFACT_RETENTION_DAYS', 7, 1, 30),
    cloudflareTrustProxy: boolEnv('CLOUDFLARE_TRUST_PROXY', false),
    cloudflareRunnerDockerLoopbackHttp: boolEnv('CLOUDFLARE_RUNNER_DOCKER_LOOPBACK_HTTP', false),

    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword,
    adminSessionTtlMs: intEnv('ADMIN_SESSION_TTL_MS', 43200000, 300000, 604800000),
    adminLoginMaxAttempts: intEnv('ADMIN_LOGIN_MAX_ATTEMPTS', 5, 1, 50),
    adminLoginWindowMs: intEnv('ADMIN_LOGIN_WINDOW_MS', 900000, 60000, 86400000),
    adminCookieSecure: boolEnv('ADMIN_COOKIE_SECURE', false),

    atomicAuthUrl: process.env.ATOMICMAIL_AUTH_URL || 'https://auth.atomicmail.ai',
    atomicApiUrl: process.env.ATOMICMAIL_API_URL || 'https://api.atomicmail.ai',
    atomicWatchMode: enumEnv('ATOMICMAIL_WATCH_MODE', 'on-demand', ['on-demand', 'scheduled']),
    atomicCliCommand: process.env.ATOMICMAIL_CLI_COMMAND || 'npx',
    atomicCliPrefixArgs: jsonArrayEnv(
      'ATOMICMAIL_CLI_PREFIX_ARGS_JSON',
      ['-y', '--package=@atomicmail/agent-skill@0.3.26', 'atomicmail'],
    ),
  });
}
