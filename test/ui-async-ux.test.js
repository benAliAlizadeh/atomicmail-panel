import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('interactive list requests supersede stale responses instead of silently dropping new intent', () => {
  assert.match(app, /function beginLatestRequest/);
  assert.match(app, /current\?\.controller\.abort\(\)/);
  assert.match(app, /request\.isCurrent\(\)/);
  assert.match(app, /loadInbox\(\{ background = false/);
  assert.doesNotMatch(app, /if \(!state\.selectedMailbox \|\| state\.mailRefreshBusy\) return/);
});

test('polling is non-overlapping and backs off when no registration is active', () => {
  assert.match(app, /schedulePoll\(active \? 2500 : 10000\)/);
  assert.match(app, /if \(state\.pollBusy/);
  assert.doesNotMatch(app, /setInterval\(poll,\s*2000\)/);
});

test('long operations expose accessible progress and preserve compose delivery state', () => {
  assert.match(html, /id="globalActivity"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="composeModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="composeProgress"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(app, /function setButtonBusy/);
  assert.match(app, /function setComposeBusy/);
  assert.match(app, /beforeunload/);
  assert.match(styles, /\.btn\.primary\[aria-busy="true"\]/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('Cloudflare manual assistant exposes simple Focus Mode and keeps runner controls out of the primary UX', () => {
  const primaryCloudflare = html.slice(html.indexOf('data-view="cloudflare"'), html.indexOf('data-view="cloudflare-legacy"'));
  assert.match(html, /data-view="cloudflare"/);
  assert.match(html, /id="manualCloudflareBatchModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="createCloudflareSelection"[^>]+disabled/);
  assert.match(primaryCloudflare, /id="manualCloudflareFocusPanel"/);
  assert.match(primaryCloudflare, /Open Cloudflare Signup/);
  assert.match(primaryCloudflare, /Signup Done/);
  assert.match(primaryCloudflare, /Check Inbox/);
  assert.match(primaryCloudflare, /Open Verification Link/);
  assert.match(primaryCloudflare, /Mark Verified &amp; Next/);
  assert.doesNotMatch(primaryCloudflare, /Runner|Pairing|Playwright/);
  assert.match(app, /selectedCloudflareMailboxIds: new Set/);
  assert.match(app, /loadManualCloudflare\(\{ background = false/);
  assert.match(app, /beginLatestRequest\('manual-cloudflare'/);
  assert.match(app, /regenerate-password/);
  assert.match(app, /signup-done/);
  assert.match(app, /check-inbox/);
  assert.match(app, /saved verification evidence is still available/);
  assert.match(html, /id="manualCloudflareFocusMessage"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(app, /verification-link/);
  assert.match(app, /Marking account verified and loading the next account/);
  assert.match(app, /mail_rate_limited/);
  assert.match(app, /\/api\/cloudflare\/eligible-mailboxes/);
  assert.match(styles, /\.cloudflare-focus-panel/);
  assert.match(styles, /\.pill\.verification_received/);
});
