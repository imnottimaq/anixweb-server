import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';

const origin = 'http://localhost:5173';
const secret = 'integration-secret-at-least-thirty-two-characters';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function signSessionToken(profile: { profileId: number; login: string; avatar: string | null }, secretKey: string, expiresAt: number) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ profile, expiresAt })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
  return `${payload}.${signature}`;
}

function runtime(sessionSecret = secret, allowedOrigin = origin) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: sessionSecret, ALLOWED_ORIGINS: allowedOrigin },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      ANIXART_TEST: async request => {
        assert.equal(request.headers.get('User-Agent'), ANIXART_APP_USER_AGENT);
        const token = new URL(request.url).searchParams.get('token');
        if (token === 'outage') return new Response('unavailable', { status: 503 });
        return Response.json({
          code: 0,
          profile: { id: Number(token), login: `user${token}`, avatar: null },
        });
      },
    },
  }));
}

function post(mf: Miniflare, path: string, body: unknown, session?: string) {
  return mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(mf: Miniflare, id: number | string) {
  const response = await post(mf, '/api/v2/session', { token: String(id) });
  assert.equal(response.status, 200);
  return (await response.json() as { session: string }).session;
}

test('userSettings: per-account isolation prevents user A from reading or overwriting user B settings', async () => {
  const mf = runtime();
  try {
    const userA = await login(mf, 10);
    const userB = await login(mf, 20);
    const userC = await login(mf, 30);

    // 1. Initial GET for all users returns 404 SETTINGS_NOT_FOUND
    for (const [name, token] of [['A', userA], ['B', userB], ['C', userC]] as const) {
      const getRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
        headers: { Origin: origin, Authorization: `Bearer ${token}` },
      });
      assert.equal(getRes.status, 404, `User ${name} should have 404 initially`);
      assert.equal((await getRes.json() as { code: string }).code, 'SETTINGS_NOT_FOUND');
    }

    // 2. User A saves settings
    const settingsA = {
      theme: 'dark',
      compactMode: true,
      player: { volume: 85, autoplay: true },
    };
    const saveARes = await post(mf, '/api/v2/user/settings', settingsA, userA);
    assert.equal(saveARes.status, 200);
    assert.equal((await saveARes.json() as { ok: boolean }).ok, true);

    // 3. User A retrieves settings -> matches settingsA
    const getARes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userA}` },
    });
    assert.equal(getARes.status, 200);
    const getAJson = await getARes.json() as { ok: boolean; settings: typeof settingsA };
    assert.deepEqual(getAJson.settings, settingsA);

    // 4. User B still has no settings (cannot read User A's settings)
    const getBInitial = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userB}` },
    });
    assert.equal(getBInitial.status, 404);

    // 5. User B saves distinct settings
    const settingsB = {
      theme: 'light',
      compactMode: false,
      player: { volume: 20, autoplay: false },
    };
    const saveBRes = await post(mf, '/api/v2/user/settings', settingsB, userB);
    assert.equal(saveBRes.status, 200);

    // 6. User B retrieves settings -> matches settingsB
    const getBRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userB}` },
    });
    assert.equal(getBRes.status, 200);
    assert.deepEqual((await getBRes.json() as { ok: boolean; settings: typeof settingsB }).settings, settingsB);

    // 7. Verify User A settings were NOT corrupted or overwritten by User B
    const verifyARes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userA}` },
    });
    assert.equal(verifyARes.status, 200);
    assert.deepEqual((await verifyARes.json() as { ok: boolean; settings: typeof settingsA }).settings, settingsA);

    // 8. Cross-account spoofed write attempt:
    // User A attempts to write settings for User B by specifying profileId: 20 in payload
    const spoofPayload = {
      profileId: 20,
      theme: 'hacked-by-user-A',
      player: { volume: 0 },
    };
    const spoofRes = await post(mf, '/api/v2/user/settings', spoofPayload, userA);
    assert.equal(spoofRes.status, 200);

    // User B's settings MUST remain untouched
    const getBAfterSpoof = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userB}` },
    });
    assert.equal(getBAfterSpoof.status, 200);
    assert.deepEqual((await getBAfterSpoof.json() as { ok: boolean; settings: typeof settingsB }).settings, settingsB);

    // User C remains completely isolated
    const getCRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${userC}` },
    });
    assert.equal(getCRes.status, 404);
  } finally {
    await mf.dispose();
  }
});

test('userSettings: missing or invalid credentials / session token handling', async () => {
  const mf = runtime();
  try {
    const validSession = await login(mf, 1);
    const [payload, sig] = validSession.split('.');

    // 1. Missing Authorization header on GET and POST
    const noAuthGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin },
    });
    assert.equal(noAuthGet.status, 401);
    assert.equal((await noAuthGet.json() as { code: string }).code, 'SESSION_REQUIRED');

    const noAuthPost = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(noAuthPost.status, 401);
    assert.equal((await noAuthPost.json() as { code: string }).code, 'SESSION_REQUIRED');

    // 2. Empty or malformed Authorization header scheme (not "Bearer ...")
    const badSchemeGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(badSchemeGet.status, 401);
    assert.equal((await badSchemeGet.json() as { code: string }).code, 'SESSION_REQUIRED');

    const emptyBearerGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: 'Bearer ' },
    });
    assert.equal(emptyBearerGet.status, 401);
    assert.equal((await emptyBearerGet.json() as { code: string }).code, 'SESSION_REQUIRED');

    // 3. Corrupted / unparseable token on GET and POST
    const corruptGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: 'Bearer invalid.token' },
    });
    assert.equal(corruptGet.status, 401);
    assert.equal((await corruptGet.json() as { code: string }).code, 'SESSION_INVALID');

    const corruptPost = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer invalid.token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(corruptPost.status, 401);
    assert.equal((await corruptPost.json() as { code: string }).code, 'SESSION_INVALID');

    // 4. Expired token on GET and POST
    const expiredToken = await signSessionToken({ profileId: 1, login: 'user1', avatar: null }, secret, Date.now() - 1000);

    const expiredGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(expiredGet.status, 401);
    assert.equal((await expiredGet.json() as { code: string }).code, 'SESSION_INVALID');

    const expiredPost = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${expiredToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(expiredPost.status, 401);
    assert.equal((await expiredPost.json() as { code: string }).code, 'SESSION_INVALID');

    // 5. Tampered signature on GET and POST
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith('Z') ? 'Y' : 'Z');
    const tamperedToken = `${payload}.${tamperedSig}`;

    const tamperedGet = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      headers: { Origin: origin, Authorization: `Bearer ${tamperedToken}` },
    });
    assert.equal(tamperedGet.status, 401);
    assert.equal((await tamperedGet.json() as { code: string }).code, 'SESSION_INVALID');

    const tamperedPost = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${tamperedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(tamperedPost.status, 401);
    assert.equal((await tamperedPost.json() as { code: string }).code, 'SESSION_INVALID');
  } finally {
    await mf.dispose();
  }
});

test('userSettings: validation rejects malformed, oversized, and corrupted settings payloads', async () => {
  const mf = runtime();
  try {
    const session = await login(mf, 1);

    // 1. Invalid JSON body string
    const invalidJsonRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: '{"theme": "dark", unclosed_json',
    });
    assert.equal(invalidJsonRes.status, 400);
    assert.equal((await invalidJsonRes.json() as { code: string }).code, 'INVALID_BODY');

    // 2. Non-object JSON: array
    const arrayRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(arrayRes.status, 400);
    assert.equal((await arrayRes.json() as { code: string }).code, 'INVALID_BODY');

    // 3. Non-object JSON: primitive string
    const stringRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify('plain string payload'),
    });
    assert.equal(stringRes.status, 400);
    assert.equal((await stringRes.json() as { code: string }).code, 'INVALID_BODY');

    // 4. Non-object JSON: number
    const numberRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: '12345',
    });
    assert.equal(numberRes.status, 400);
    assert.equal((await numberRes.json() as { code: string }).code, 'INVALID_BODY');

    // 5. Non-object JSON: null
    const nullRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(nullRes.status, 400);
    assert.equal((await nullRes.json() as { code: string }).code, 'INVALID_BODY');

    // 6. Oversized body (> 8192 bytes)
    const largeObject = { padding: 'x'.repeat(9000) };
    const largeRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(largeObject),
    });
    assert.equal(largeRes.status, 413);
    assert.equal((await largeRes.json() as { code: string }).code, 'BODY_TOO_LARGE');

    // 7. Content-Length header exceeding 8192 bytes with matching payload
    const payload9000 = 'x'.repeat(9000);
    const headerOversizedRes = await mf.dispatchFetch('http://localhost/api/v2/user/settings', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        'Content-Length': String(payload9000.length),
      },
      body: payload9000,
    });
    assert.equal(headerOversizedRes.status, 413);
    assert.equal((await headerOversizedRes.json() as { code: string }).code, 'BODY_TOO_LARGE');
  } finally {
    await mf.dispose();
  }
});
