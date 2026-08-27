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

export function loadConfig() {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, process.env.DATA_DIR || './data');

  return Object.freeze({
    host: process.env.HOST || '127.0.0.1',
    port: intEnv('PORT', 8787, 1, 65535),
    dataDir,
    dbPath: path.resolve(cwd, process.env.DB_PATH || path.join(dataDir, 'atomicmail-panel.sqlite')),
    credentialsRoot: path.join(dataDir, 'credentials'),

    maxBatchSize: intEnv('MAX_BATCH_SIZE', 100, 1, 5000),
    usernameMinLength: intEnv('USERNAME_MIN_LENGTH', 10, 5, 21),
    usernameMaxLength: intEnv('USERNAME_MAX_LENGTH', 14, 5, 21),

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

    atomicAuthUrl: process.env.ATOMICMAIL_AUTH_URL || 'https://auth.atomicmail.ai',
    atomicApiUrl: process.env.ATOMICMAIL_API_URL || 'https://api.atomicmail.ai',
    atomicCliCommand: process.env.ATOMICMAIL_CLI_COMMAND || 'npx',
    atomicCliPrefixArgs: jsonArrayEnv(
      'ATOMICMAIL_CLI_PREFIX_ARGS_JSON',
      ['-y', '--package=@atomicmail/agent-skill@0.3.26', 'atomicmail'],
    ),
  });
}
