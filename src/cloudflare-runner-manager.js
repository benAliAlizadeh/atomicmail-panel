import crypto from 'node:crypto';
import { newId } from './utils.js';

export const CLOUDFLARE_RUNNER_PROTOCOL = 1;

function tokenHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function loopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function privateIpv4(value) {
  const address = String(value || '').replace(/^::ffff:/i, '');
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function randomPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function exposedError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

export class CloudflareRunnerManager {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    this.pairings = new Map();
    this.sessions = new Map();
    this.failedExchanges = new Map();
  }

  prune() {
    const now = Date.now();
    for (const [hash, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) this.pairings.delete(hash);
    }
    for (const [hash, session] of this.sessions) {
      if (session.revoked || session.lastSeenAt + 12 * 60 * 60 * 1000 <= now) this.sessions.delete(hash);
    }
    for (const [ip, failed] of this.failedExchanges) {
      if (failed.startedAt + 15 * 60 * 1000 <= now) this.failedExchanges.delete(ip);
    }
  }

  transportAllowed(req) {
    if (loopbackAddress(req?.socket?.remoteAddress)) return true;
    const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
    const dockerLoopback = this.config.cloudflareRunnerDockerLoopbackHttp
      && privateIpv4(req?.socket?.remoteAddress)
      && ['127.0.0.1', 'localhost'].includes(host);
    if (dockerLoopback) return true;
    const forwardedSecure = this.config.cloudflareTrustProxy
      && String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
    return Boolean(this.config.adminPassword && (req?.socket?.encrypted || forwardedSecure));
  }

  issuePairing() {
    this.prune();
    const code = randomPairingCode();
    const expiresAt = Date.now() + Number(this.config.cloudflarePairingTtlMs || 600000);
    this.pairings.set(tokenHash(code.toUpperCase()), { expiresAt });
    this.store.audit('info', 'cloudflare.runner_pairing_issued', 'Issued a short-lived Cloudflare runner pairing code');
    return { code, expiresAt: new Date(expiresAt).toISOString(), protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL };
  }

  exchange(req, { code, protocolVersion, name }) {
    this.prune();
    const ip = String(req?.socket?.remoteAddress || 'unknown');
    const failed = this.failedExchanges.get(ip);
    if (failed && failed.count >= 5 && failed.startedAt + 15 * 60 * 1000 > Date.now()) {
      throw exposedError('Too many invalid runner pairing attempts', 429, 'runner_pair_rate_limited');
    }
    if (!this.transportAllowed(req)) {
      throw exposedError('Remote Cloudflare runners require HTTPS and enabled admin authentication', 403, 'runner_transport_insecure');
    }
    if (Number(protocolVersion) !== CLOUDFLARE_RUNNER_PROTOCOL) {
      throw exposedError(`Runner protocol ${protocolVersion} is not supported`, 409, 'runner_protocol_mismatch');
    }
    const normalized = String(code || '').trim().toUpperCase();
    const hash = tokenHash(normalized);
    const pairing = this.pairings.get(hash);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      const current = failed && failed.startedAt + 15 * 60 * 1000 > Date.now()
        ? failed
        : { count: 0, startedAt: Date.now() };
      current.count += 1;
      this.failedExchanges.set(ip, current);
      throw exposedError('Runner pairing code is invalid or expired', 401, 'runner_pair_invalid');
    }
    this.pairings.delete(hash);
    this.failedExchanges.delete(ip);

    // V1 deliberately supports one visible runner so two operators can never
    // race the same manual Cloudflare form.
    for (const session of this.sessions.values()) session.revoked = true;
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const session = {
      id: newId('cfrunner'),
      name: String(name || 'Operator browser').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80),
      tokenHash: tokenHash(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      activeItemId: null,
      activeGeneration: null,
      revoked: false,
      commands: [],
    };
    this.sessions.set(session.tokenHash, session);
    this.store.audit('info', 'cloudflare.runner_paired', `Paired Cloudflare runner ${session.id}`);
    return { token, runnerId: session.id, protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL };
  }

  authenticate(req) {
    this.prune();
    if (!this.transportAllowed(req)) {
      throw exposedError('Cloudflare runner transport is not secure', 403, 'runner_transport_insecure');
    }
    const authorization = String(req?.headers?.authorization || '');
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) throw exposedError('Cloudflare runner authentication is required', 401, 'runner_auth_required');
    const session = this.sessions.get(tokenHash(match[1]));
    if (!session || session.revoked) throw exposedError('Cloudflare runner token is invalid or expired', 401, 'runner_auth_invalid');
    session.lastSeenAt = Date.now();
    return session;
  }

  heartbeat(session, { activeItemId = null, generation = null } = {}) {
    session.lastSeenAt = Date.now();
    session.activeItemId = activeItemId ? String(activeItemId) : null;
    session.activeGeneration = generation == null ? null : Number(generation);
    const commands = session.commands.splice(0, 20);
    return { ok: true, serverTime: new Date().toISOString(), commands };
  }

  requestCommand(type, itemId) {
    const live = this.liveSession();
    if (!live) return false;
    live.commands.push({ type, itemId: String(itemId || '') });
    return true;
  }

  liveSession() {
    this.prune();
    const offlineMs = Number(this.config.cloudflareRunnerOfflineMs || 45000);
    return [...this.sessions.values()].find((session) => !session.revoked && session.lastSeenAt + offlineMs > Date.now()) || null;
  }

  revoke() {
    for (const session of this.sessions.values()) session.revoked = true;
    this.prune();
    this.store.audit('warn', 'cloudflare.runner_revoked', 'Cloudflare runner session revoked by operator');
  }

  status() {
    const session = this.liveSession();
    return {
      online: Boolean(session),
      runnerId: session?.id || null,
      name: session?.name || null,
      busy: Boolean(session?.activeItemId),
      activeItemId: session?.activeItemId || null,
      lastSeenAt: session ? new Date(session.lastSeenAt).toISOString() : null,
      protocolVersion: CLOUDFLARE_RUNNER_PROTOCOL,
      remoteRequiresHttps: true,
    };
  }
}
