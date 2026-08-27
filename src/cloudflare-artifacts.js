import fs from 'node:fs';
import path from 'node:path';

function safeItemId(value) {
  const id = String(value || '');
  if (!/^cfitem_[a-f0-9]{32}$/i.test(id)) throw new Error('Invalid Cloudflare artifact item');
  return id;
}

export class CloudflareArtifactStore {
  constructor({ config, vault }) {
    this.config = config;
    this.vault = vault;
    this.nextPruneAt = 0;
    fs.mkdirSync(config.cloudflareArtifactDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(config.cloudflareArtifactDir, 0o700); } catch {}
    this.prune();
  }

  save(itemId, attempt, base64) {
    this.pruneIfDue();
    const id = safeItemId(itemId);
    const data = Buffer.from(String(base64 || ''), 'base64');
    if (!data.length || data.length > 2 * 1024 * 1024) throw new Error('Cloudflare failure screenshot is invalid or too large');
    if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Cloudflare failure screenshot is not a PNG image');
    }
    const number = Math.max(1, Math.min(99, Number(attempt) || 1));
    const name = `cf-artifact-${id}-${number}.enc`;
    const target = path.join(this.config.cloudflareArtifactDir, name);
    const envelope = this.vault.sealCloudflareSecret(data, { purpose: 'cloudflare-artifact', id: name });
    fs.writeFileSync(target, envelope, { mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}
    return name;
  }

  read(name) {
    const safe = path.basename(String(name || ''));
    if (safe !== name || !/^cf-artifact-cfitem_[a-f0-9]{32}-[0-9]+\.enc$/i.test(safe)) {
      throw Object.assign(new Error('Cloudflare artifact was not found'), { statusCode: 404, expose: true });
    }
    const target = path.join(this.config.cloudflareArtifactDir, safe);
    if (!fs.existsSync(target)) throw Object.assign(new Error('Cloudflare artifact was not found'), { statusCode: 404, expose: true });
    return this.vault.openCloudflareSecret(fs.readFileSync(target, 'utf8'), {
      purpose: 'cloudflare-artifact', id: safe, asBuffer: true,
    });
  }

  prune() {
    const cutoff = Date.now() - Number(this.config.cloudflareArtifactRetentionDays || 7) * 86400000;
    let removed = 0;
    for (const entry of fs.readdirSync(this.config.cloudflareArtifactDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('cf-artifact-') || !entry.name.endsWith('.enc')) continue;
      const target = path.join(this.config.cloudflareArtifactDir, entry.name);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) {
          fs.rmSync(target, { force: true });
          removed += 1;
        }
      } catch {}
    }
    this.nextPruneAt = Date.now() + 60 * 60 * 1000;
    return removed;
  }

  pruneIfDue() {
    return Date.now() >= this.nextPruneAt ? this.prune() : 0;
  }
}
