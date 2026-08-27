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
