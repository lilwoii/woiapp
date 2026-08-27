import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { appAssociationResponse } from '../hosting/worker.js';

const validFingerprint = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, '0')
).join(':');

test('Apple association allows only Spottr public link surfaces with explicit identifiers', async () => {
  const response = appAssociationResponse('/.well-known/apple-app-site-association', {
    SPOTTR_APPLE_TEAM_ID: 'A1B2C3D4E5',
    SPOTTR_IOS_BUNDLE_ID: 'com.spottr.food',
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);
  const body = await response.json();
  assert.equal(body.applinks.details[0].appID, 'A1B2C3D4E5.com.spottr.food');
  assert.deepEqual(
    body.applinks.details[0].components.map((component) => component['/']),
    ['/place/*', '/profile/*', '/navigation/*', '/auth*', '/reset-password*'],
  );
});

test('Apple association fails closed for missing or malformed signing identity', async () => {
  for (const env of [
    { SPOTTR_IOS_BUNDLE_ID: 'com.spottr.food' },
    { SPOTTR_APPLE_TEAM_ID: 'not-a-team', SPOTTR_IOS_BUNDLE_ID: 'com.spottr.food' },
    { SPOTTR_APPLE_TEAM_ID: 'A1B2C3D4E5', SPOTTR_IOS_BUNDLE_ID: 'invalid bundle' },
  ]) {
    const response = appAssociationResponse('/.well-known/apple-app-site-association', env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('Android association validates and normalizes the release certificate fingerprint', async () => {
  const response = appAssociationResponse('/.well-known/assetlinks.json', {
    SPOTTR_ANDROID_PACKAGE: 'com.spottr.food',
    SPOTTR_ANDROID_CERT_SHA256: `${validFingerprint},${validFingerprint.toUpperCase()}`,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body[0].target.sha256_cert_fingerprints, [validFingerprint.toUpperCase()]);
});

test('Android association fails closed for an invalid package or certificate fingerprint', () => {
  for (const env of [
    { SPOTTR_ANDROID_PACKAGE: 'com.spottr.food' },
    { SPOTTR_ANDROID_PACKAGE: 'invalid package', SPOTTR_ANDROID_CERT_SHA256: validFingerprint },
    { SPOTTR_ANDROID_PACKAGE: 'com.spottr.food', SPOTTR_ANDROID_CERT_SHA256: 'AA:BB' },
  ]) {
    assert.equal(appAssociationResponse('/.well-known/assetlinks.json', env).status, 404);
  }
});

test('public profile URLs fall back to the exported dynamic profile route', async () => {
  const requestedPaths = [];
  const env = {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        requestedPaths.push(pathname);
        return pathname === '/profile/[id].html'
          ? new Response('<html><main>Profile</main></html>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
          : new Response('Not found', { status: 404 });
      },
    },
  };

  const response = await worker.fetch(new Request('https://spottr.app/profile/member-1'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(requestedPaths, ['/profile/member-1', '/profile/member-1.html', '/profile/[id].html']);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});
