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
