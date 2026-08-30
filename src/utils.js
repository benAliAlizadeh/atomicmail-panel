import { randomInt, randomUUID } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(ms, ratio = 0.2) {
  if (ms <= 0) return 0;
  const spread = Math.max(1, Math.floor(ms * ratio));
  return Math.max(0, ms + randomInt(-spread, spread + 1));
}

export function retryDelay(attempt, baseMs, maxMs) {
  const exponent = Math.max(0, attempt - 1);
  return jitter(Math.min(maxMs, baseMs * (2 ** exponent)));
}

export function redactSecrets(input) {
  if (!input) return '';
  return String(input)
    .replace(/Authorization\s*:\s*Bearer\s+[^\s"']+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[JWT_REDACTED]')
    .replace(/\bam_[a-zA-Z0-9_-]{8,}\b/g, '[API_KEY_REDACTED]')
    .replace(/\bcfk_[a-zA-Z0-9_-]{8,}\b/g, '[CLOUDFLARE_API_KEY_REDACTED]')
    .replace(/\bcfat_[a-zA-Z0-9_-]{8,}\b/g, '[CLOUDFLARE_API_TOKEN_REDACTED]')
    .replace(/("apiKey"\s*:\s*")[^"]+("\s*)/gi, '$1[REDACTED]$2')
    .replace(/("(?:globalApiKey|apiToken|destinationPassword|destination_password|destination_password_ciphertext|password)"\s*:\s*")[^"]*("\s*)/gi, '$1[REDACTED]$2')
    .replace(/(?:[a-z]:)?[^\s"']*[\\/]credentials[\\/][^\s"']+/gi, '[CREDENTIAL_PATH_REDACTED]')
    .replace(/(?:[a-z]:)?[^\s"']*[\\/]secrets[\\/]data\.key/gi, '[DATA_KEY_PATH_REDACTED]');
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
