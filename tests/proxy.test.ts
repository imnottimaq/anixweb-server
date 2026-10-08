import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ANIXART_APP_USER_AGENT } from '../src/userAgent.ts';

const origin = 'http://localhost:5173';
const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });

type UpstreamHandler = (request: Request) => Promise<Response>;
let currentHandler: UpstreamHandler = async () => new Response('default ok');

function runtime(secret = 'integration-secret-at-least-thirty-two-characters', allowed = origin) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-07',
    bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: allowed },
    durableObjects: {
      ROOMS: { className: 'RoomObject', useSQLite: true },
      DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
    },
    serviceBindings: {
      PROXY_TEST: async req => currentHandler(req),
      ANIXART_TEST: async req => currentHandler(req),
      KODIK_TEST: async req => currentHandler(req),
    },
  }));
}

test('proxy: OPTIONS preflight returns 204 with full CORS headers', async () => {
  const mf = runtime();
  try {
    for (const path of ['/agentproxy', '/corsproxy']) {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method: 'OPTIONS',
        headers: { Origin: origin },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Vary'), 'Origin');
      assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, POST, OPTIONS');
      const allowHeaders = response.headers.get('Access-Control-Allow-Headers');
      assert.ok(allowHeaders?.includes('Accept'));
      assert.ok(allowHeaders?.includes('Accept-Language'));
      assert.ok(allowHeaders?.includes('Content-Type'));
      assert.ok(allowHeaders?.includes('Api-Version'));
      assert.ok(allowHeaders?.includes('Range'));
      assert.ok(allowHeaders?.includes('If-Range'));
      assert.ok(allowHeaders?.includes('If-None-Match'));
      assert.ok(allowHeaders?.includes('If-Modified-Since'));
      const exposeHeaders = response.headers.get('Access-Control-Expose-Headers');
      assert.ok(exposeHeaders?.includes('Content-Type'));
      assert.ok(exposeHeaders?.includes('Content-Range'));
      assert.ok(exposeHeaders?.includes('Accept-Ranges'));
      assert.ok(exposeHeaders?.includes('ETag'));
      assert.ok(exposeHeaders?.includes('Last-Modified'));
    }
  } finally {
    await mf.dispose();
  }
});

test('proxy: Origin check rejects forbidden origins with 403 ORIGIN_FORBIDDEN', async () => {
  const mf = runtime();
  try {
    const response = await mf.dispatchFetch(`http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/test')}`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'ORIGIN_FORBIDDEN');
  } finally {
    await mf.dispose();
  }
});

test('proxy: works without SESSION_SECRET configured', async () => {
  const unconfigured = runtime('');
  try {
    currentHandler = async () => new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    const response = await unconfigured.dispatchFetch(
      `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/video')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
  } finally {
    await unconfigured.dispose();
  }
});

test('proxy: URL validation enforces HTTPS, port 443, no credentials, and exact allowlist', async () => {
  const mf = runtime();
  try {
    // Missing URL
    const noUrl = await mf.dispatchFetch('http://localhost/agentproxy', { headers: { Origin: origin } });
    assert.equal(noUrl.status, 400);
    assert.equal((await noUrl.json()).code, 'INVALID_URL');

    // Malformed URL
    const badUrl = await mf.dispatchFetch('http://localhost/agentproxy?url=not_a_valid_url', { headers: { Origin: origin } });
    assert.equal(badUrl.status, 400);
    assert.equal((await badUrl.json()).code, 'INVALID_URL');

    // HTTP protocol (not https)
    const httpUrl = await mf.dispatchFetch(`http://localhost/corsproxy?url=${encodeURIComponent('http://kodikplayer.com/test')}`, { headers: { Origin: origin } });
    assert.equal(httpUrl.status, 400);
    assert.equal((await httpUrl.json()).code, 'INVALID_URL');

    // Username/password in URL
    const credUrl = await mf.dispatchFetch(`http://localhost/corsproxy?url=${encodeURIComponent('https://user:pass@kodikplayer.com/test')}`, { headers: { Origin: origin } });
    assert.equal(credUrl.status, 400);
    assert.equal((await credUrl.json()).code, 'INVALID_URL');

    // Explicit non-443 port
    const portUrl = await mf.dispatchFetch(`http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com:8443/test')}`, { headers: { Origin: origin } });
    assert.equal(portUrl.status, 400);
    assert.equal((await portUrl.json()).code, 'INVALID_URL');

    // Disallowed host
    const evilHost = await mf.dispatchFetch(`http://localhost/agentproxy?url=${encodeURIComponent('https://evil.example.com/test')}`, { headers: { Origin: origin } });
    assert.equal(evilHost.status, 400);
    assert.equal((await evilHost.json()).code, 'HOST_NOT_ALLOWED');

    // Subdomain of allowed host (must be exact hostname)
    const subHost = await mf.dispatchFetch(`http://localhost/corsproxy?url=${encodeURIComponent('https://sub.kodikplayer.com/test')}`, { headers: { Origin: origin } });
    assert.equal(subHost.status, 400);
    assert.equal((await subHost.json()).code, 'HOST_NOT_ALLOWED');

    // Method not allowed (e.g. PUT, DELETE)
    const putRes = await mf.dispatchFetch(`http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/test')}`, {
      method: 'PUT',
      headers: { Origin: origin },
    });
    assert.equal(putRes.status, 405);
    assert.equal((await putRes.json()).code, 'METHOD_NOT_ALLOWED');
  } finally {
    await mf.dispose();
  }
});

test('proxy: header forwarding rules and User-Agent handling', async () => {
  const mf = runtime();
  try {
    let capturedReq: Request | null = null;
    currentHandler = async req => {
      capturedReq = req;
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    };

    // Test /agentproxy: sets ANIXART_APP_USER_AGENT, strips sensitive headers, forwards allowed headers
    const agentUrl = `http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/api/v2/test')}`;
    const agentRes = await mf.dispatchFetch(agentUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'User-Agent': 'Mozilla/5.0 Client',
        Cookie: 'session=secret',
        Authorization: 'Bearer supersecret',
        Host: 'localhost',
        Referer: 'http://localhost/referer',
        Accept: 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Content-Type': 'application/json',
        'Api-Version': '2.0',
        Range: 'bytes=0-100',
        'If-Range': 'etag123',
        'If-None-Match': 'etag456',
        'If-Modified-Since': 'Wed, 21 Oct 2025 07:28:00 GMT',
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(agentRes.status, 200);
    assert.ok(capturedReq);
    // User-Agent must be ANIXART_APP_USER_AGENT
    assert.equal((capturedReq as Request).headers.get('User-Agent'), ANIXART_APP_USER_AGENT);
    // Forbidden headers must NOT be forwarded
    assert.equal((capturedReq as Request).headers.get('Cookie'), null);
    assert.equal((capturedReq as Request).headers.get('Authorization'), null);
    assert.equal((capturedReq as Request).headers.get('Origin'), null);
    assert.equal((capturedReq as Request).headers.get('Referer'), null);
    // Allowed headers MUST be forwarded
    assert.equal((capturedReq as Request).headers.get('Accept'), 'application/json');
    assert.equal((capturedReq as Request).headers.get('Accept-Language'), 'ru-RU,ru;q=0.9');
    assert.equal((capturedReq as Request).headers.get('Content-Type'), 'application/json');
    assert.equal((capturedReq as Request).headers.get('Api-Version'), '2.0');
    assert.equal((capturedReq as Request).headers.get('Range'), 'bytes=0-100');
    assert.equal((capturedReq as Request).headers.get('If-Range'), 'etag123');
    assert.equal((capturedReq as Request).headers.get('If-None-Match'), 'etag456');
    assert.equal((capturedReq as Request).headers.get('If-Modified-Since'), 'Wed, 21 Oct 2025 07:28:00 GMT');

    // Test /corsproxy: must NOT set User-Agent and must NOT forward incoming User-Agent
    capturedReq = null;
    const corsUrl = `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/segment.ts')}`;
    const corsRes = await mf.dispatchFetch(corsUrl, {
      method: 'GET',
      headers: {
        Origin: origin,
        'User-Agent': 'Mozilla/5.0 Client',
        Range: 'bytes=500-1000',
      },
    });
    assert.equal(corsRes.status, 200);
    assert.ok(capturedReq);
    assert.equal((capturedReq as Request).headers.get('User-Agent'), null);
    assert.equal((capturedReq as Request).headers.get('Range'), 'bytes=500-1000');
  } finally {
    await mf.dispose();
  }
});

test('proxy: POST body fidelity (JSON, multipart) and 9 MiB size limits', async () => {
  const mf = runtime();
  try {
    let capturedBody: Uint8Array | null = null;
    let capturedContentType: string | null = null;
    currentHandler = async req => {
      capturedContentType = req.headers.get('Content-Type');
      capturedBody = new Uint8Array(await req.arrayBuffer());
      return new Response('received', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    };

    // Multipart with boundary preserved intact
    const boundary = '----WebKitFormBoundaryXyZ123';
    const multipartData = `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\nPNG_DATA_BYTES\r\n--${boundary}--\r\n`;
    const targetUrl = `http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/profile/avatar')}`;
    const mpRes = await mf.dispatchFetch(targetUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartData,
    });
    assert.equal(mpRes.status, 200);
    assert.equal(capturedContentType, `multipart/form-data; boundary=${boundary}`);
    assert.equal(new TextDecoder().decode(capturedBody!), multipartData);

    // Payload exceeding 9 MiB via declared Content-Length
    const largeRes = await mf.dispatchFetch(targetUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(9 * 1024 * 1024 + 1),
      },
      body: new Uint8Array(9 * 1024 * 1024 + 1),
    });
    assert.equal(largeRes.status, 413);
    assert.equal((await largeRes.json()).code, 'PAYLOAD_TOO_LARGE');

    // Payload exceeding 9 MiB via stream without large Content-Length header
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.close();
      },
    });
    const largeStreamRes = await mf.dispatchFetch(targetUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/octet-stream',
      },
      body: stream,
      duplex: 'half',
    });
    assert.equal(largeStreamRes.status, 413);
    assert.equal((await largeStreamRes.json()).code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await mf.dispose();
  }
});

test('proxy: redirect blocking returns 502 PROXY_REDIRECT_BLOCKED', async () => {
  const mf = runtime();
  try {
    for (const status of [301, 302, 307, 308]) {
      currentHandler = async () => new Response(null, {
        status,
        headers: { Location: 'https://evil.example.com/redirect' },
      });
      const response = await mf.dispatchFetch(
        `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/video')}`,
        { headers: { Origin: origin } }
      );
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, 'PROXY_REDIRECT_BLOCKED');
    }
  } finally {
    await mf.dispose();
  }
});

test('proxy: streaming response preserves 206/416 status, headers, strips Set-Cookie and Content-Length', async () => {
  const mf = runtime();
  try {
    currentHandler = async () => new Response('partial video stream content', {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 0-27/1000',
        'Accept-Ranges': 'bytes',
        ETag: '"video123"',
        'Last-Modified': 'Wed, 21 Oct 2025 07:28:00 GMT',
        'Set-Cookie': 'session=victim; Path=/',
        'Access-Control-Allow-Origin': '*',
      },
    });

    const response = await mf.dispatchFetch(
      `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/video.mp4')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-27/1000');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('ETag'), '"video123"');
    assert.equal(response.headers.get('Last-Modified'), 'Wed, 21 Oct 2025 07:28:00 GMT');
    // Set-Cookie must be stripped
    assert.equal(response.headers.get('Set-Cookie'), null);
    // Upstream CORS must be replaced by our own allowed origin
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(await response.text(), 'partial video stream content');

    // 416 Range Not Satisfiable
    currentHandler = async () => new Response('range error', {
      status: 416,
      headers: { 'Content-Range': 'bytes */1000' },
    });
    const res416 = await mf.dispatchFetch(
      `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/video.mp4')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(res416.status, 416);
    assert.equal(res416.headers.get('Content-Range'), 'bytes */1000');

    // Credential-bearing API responses must have Cache-Control: no-store
    currentHandler = async () => new Response('{"token":"secret"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
    const apiRes = await mf.dispatchFetch(
      `http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/auth')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get('Cache-Control'), 'no-store');
  } finally {
    await mf.dispose();
  }
});

test('proxy: rate limiting enforces 60 req/min on /agentproxy', async () => {
  const mf = runtime();
  try {
    currentHandler = async () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    const targetUrl = `http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/ping')}`;
    for (let i = 0; i < 60; i++) {
      const res = await mf.dispatchFetch(targetUrl, {
        headers: { Origin: origin, 'CF-Connecting-IP': '198.51.100.1' },
      });
      assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
    }
    const limitedRes = await mf.dispatchFetch(targetUrl, {
      headers: { Origin: origin, 'CF-Connecting-IP': '198.51.100.1' },
    });
    assert.equal(limitedRes.status, 429);
    assert.equal((await limitedRes.json()).code, 'RATE_LIMITED');
  } finally {
    await mf.dispose();
  }
});

test('proxy: upstream timeout and network error return fixed error codes', async () => {
  const mf = runtime();
  try {
    // Network error returns 502 UPSTREAM_ERROR
    currentHandler = async () => {
      throw new TypeError('Failed to fetch: connection refused');
    };
    const errRes = await mf.dispatchFetch(
      `http://localhost/corsproxy?url=${encodeURIComponent('https://kodikplayer.com/file')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(errRes.status, 502);
    assert.equal((await errRes.json()).code, 'UPSTREAM_ERROR');

    // Timeout returns 504 UPSTREAM_TIMEOUT
    currentHandler = async () => new Response('gateway timeout', { status: 504 });
    const timeoutRes = await mf.dispatchFetch(
      `http://localhost/agentproxy?url=${encodeURIComponent('https://api-s.anixsekai.com/slow')}`,
      { headers: { Origin: origin } }
    );
    assert.equal(timeoutRes.status, 504);
    assert.equal((await timeoutRes.json()).code, 'UPSTREAM_TIMEOUT');
  } finally {
    await mf.dispose();
  }
});
