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
  assert.match(primaryCloudflare, /Continue setup/);
  assert.match(app, /Mark Verified & Next/);
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

test('Cloudflare credential UX keeps the operator oriented without weakening secret boundaries', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(html, new RegExp(`/styles\\.css\\?v=${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(html, new RegExp(`/app\\.js\\?v=${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(html, /id="manualCloudflareNextAction"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="manualCloudflareCredentialStep"[^>]+tabindex="-1"/);
  assert.match(html, /Save \/ update credentials/);
  assert.match(html, /Show saved values/);
  assert.match(html, /id="manualCloudflareFinishStep"[^>]+tabindex="-1"/);
  assert.match(app, /function setManualCloudflareAccessSecretsVisible/);
  assert.match(app, /function guideManualCloudflareStep/);
  assert.match(app, /Saved: cfk_••••••••••••/);
  assert.match(app, /finishButton\.textContent = verified \? 'Verified'.*workflowReady \? 'Mark Verified & Next' : 'Continue setup'/);
  assert.match(app, /Credentials saved\. Next: Mark Verified & Next\./);
  assert.match(app, /fetchManualCloudflareAccessSecrets\(\)\)\.globalApiKey/);
  assert.match(styles, /\.focus-next-action/);
  assert.match(styles, /\.focus-attention/);
});

test('email creation assigns one automatic password per mailbox and Cloudflare reuses it', () => {
  assert.doesNotMatch(html, /id="destinationPassword"|id="toggleDestinationPassword"/);
  assert.match(html, /Automatic unique password/);
  assert.match(html, /Every completed email gets its own strong 20-character saved account password/);
  assert.match(html, /Email \+ Cloudflare password/);
  assert.match(html, /same encrypted password saved for this email/);
  const createFlow = app.slice(
    app.indexOf("$('#createForm').addEventListener('submit'"),
    app.indexOf("$('#jobsBody').addEventListener", app.indexOf("$('#createForm').addEventListener('submit'")),
  );
  assert.match(createFlow, /count: Number\(\$\('#batchCount'\)\.value\)/);
  assert.match(createFlow, /prefix: \$\('#batchPrefix'\)\.value/);
  assert.doesNotMatch(createFlow, /destinationPassword/);
  assert.match(app, /Updating the email and Cloudflare password together/);
  assert.match(app, /Email and Cloudflare password updated together/);
});
