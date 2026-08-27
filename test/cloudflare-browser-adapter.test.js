import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCloudflareSignup,
  inspectCloudflareVerificationRequest,
} from '../runner/cloudflare-browser-adapter.js';

test('Cloudflare signup never advances from a URL change or unsubmitted verification copy', () => {
  assert.equal(inspectCloudflareSignup({
    url: 'https://dash.cloudflare.com/profile',
    text: 'Dashboard',
    email: 'box@atomicmail.ai',
    submitObserved: true,
    signupFormVisible: false,
  }).state, 'processing_submission');

  assert.equal(inspectCloudflareSignup({
    url: 'https://dash.cloudflare.com/sign-up',
    text: 'Check your inbox for a verification email',
    email: 'box@atomicmail.ai',
    submitObserved: false,
    signupFormVisible: false,
  }).state, 'awaiting_submit');
});

test('Cloudflare signup acceptance requires operator submit, removed form, and explicit provider confirmation', () => {
  const accepted = inspectCloudflareSignup({
    url: 'https://dash.cloudflare.com/sign-up/complete',
    text: 'A verification email has been sent to box@atomicmail.ai. Check your inbox.',
    email: 'box@atomicmail.ai',
    submitObserved: true,
    signupFormVisible: false,
  });
  assert.deepEqual(accepted, { state: 'accepted', evidence: 'verification_prompt_with_email' });

  assert.equal(inspectCloudflareSignup({
    url: 'https://dash.cloudflare.com/sign-up',
    text: 'Password must contain a number',
    email: 'box@atomicmail.ai',
    submitObserved: true,
    signupFormVisible: true,
    invalidFieldVisible: true,
  }).state, 'validation_error');
});

test('Cloudflare challenge takes precedence and verification resend also needs browser evidence', () => {
  assert.equal(inspectCloudflareSignup({
    url: 'https://dash.cloudflare.com/cdn-cgi/challenge-platform',
    text: 'Check your email',
    submitObserved: true,
  }).state, 'challenge');

  assert.equal(inspectCloudflareVerificationRequest({
    url: 'https://dash.cloudflare.com/profile',
    text: 'Verification email sent to box@atomicmail.ai',
    email: 'box@atomicmail.ai',
    requestObserved: false,
  }).state, 'awaiting_action');
  assert.equal(inspectCloudflareVerificationRequest({
    url: 'https://dash.cloudflare.com/profile',
    text: 'Verification email sent to box@atomicmail.ai',
    email: 'box@atomicmail.ai',
    requestObserved: true,
  }).state, 'accepted');
});
