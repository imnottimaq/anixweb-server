import { businessLog } from './logging.ts';
import { ANIXART_APP_USER_AGENT } from './userAgent.ts';
import type { Env } from './worker.ts';

const ALLOWED_HOSTS = new Set([
  'kodikplayer.com',
  'api-s.anixsekai.com',
  'kodik.info',
  'kodik.biz',
  'kodik.cc',
  'cloud.kodik-storage.com',
  'video.sibnet.ru',
  'dv.sibnet.ru',
  'sibnet.ru',
  'rutube.ru',
  'vk.com',
  'api.vk.com',
  'oauth.vk.com',
  'ok.ru',
  'odnoklassniki.ru',
  'solodcdn.com',
  'anilibria.top',
  'test-streams.mux.dev',
]);

const APPROVED_REDIRECT_DOMAINS = [
  'sibnet.ru',
  'vkuservideo.net',
  'vkcache.com',
  'vk-cdn.me',
  'vkcdn.ru',
  'mycdn.me',
  'userapi.com',
  'vk.com',
  'ok.ru',
  'odnoklassniki.ru',
  'rutube.ru',
  'kodik-storage.com',
  'solodcdn.com',
  'anilibria.top',
  'test-streams.mux.dev',
];

function isApprovedRedirectDestination(hostname: string): boolean {
  if (ALLOWED_HOSTS.has(hostname)) {
    return true;
  }
  for (const domain of APPROVED_REDIRECT_DOMAINS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return true;
    }
  }
  return false;
}
const MAX_POST_BODY = 9 * 1024 * 1024; // 9 MiB
const FORWARD_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'api-version',
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
];
const COPY_RESPONSE_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

function proxyError(status: number, code: string, corsHeaders: Record<string, string>): Response {
  businessLog('http_rejected', { code, status });
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  for (const [name, value] of Object.entries(corsHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify({ code, message: code }), {
    status,
    headers,
  });
}

export async function handleProxyRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const isAllowedOrigin = origin && allowedOrigins.includes(origin);

  const proxyCors: Record<string, string> = isAllowedOrigin ? {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Accept-Language, Content-Type, Api-Version, Range, If-Range, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Upstream-URL',
  } : {};

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: proxyCors });
  }

  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return proxyError(405, 'METHOD_NOT_ALLOWED', proxyCors);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const isAgent = path === '/agentproxy';
  const rawTargetUrl = url.searchParams.get('url');

  if (!rawTargetUrl) {
    return proxyError(400, 'INVALID_URL', proxyCors);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    return proxyError(400, 'INVALID_URL', proxyCors);
  }

  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    (targetUrl.port !== '' && targetUrl.port !== '443')
  ) {
    return proxyError(400, 'INVALID_URL', proxyCors);
  }

  const hostname = targetUrl.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    return proxyError(400, 'HOST_NOT_ALLOWED', proxyCors);
  }

  // Rate limiting via Directory DO
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const limitKey = isAgent ? `proxy-agent:${ip}` : `proxy-cors:${ip}`;
  const maxReq = isAgent ? 60 : 600;

  try {
    const dirStub = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-v2'));
    const limitResponse = await dirStub.fetch(new Request('https://internal/limit', {
      method: 'POST',
      body: JSON.stringify({ key: limitKey, max: maxReq }),
    }));
    if (limitResponse.status === 429 || !limitResponse.ok) {
      return proxyError(429, 'RATE_LIMITED', proxyCors);
    }
  } catch {
    return proxyError(429, 'RATE_LIMITED', proxyCors);
  }

  // Body handling
  let bodyBytes: Uint8Array | null = null;
  if (request.method === 'POST') {
    const drainStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes = 32 * 1024 * 1024): Promise<void> => {
      let drained = 0;
      try {
        while (drained < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) drained += value.byteLength;
        }
      } catch {
        // Stream read errors during drain (e.g. client disconnect) are safely ignored
      }
    };

    const clHeader = request.headers.get('content-length');
    if (clHeader !== null) {
      const len = Number(clHeader);
      if (Number.isFinite(len) && len > MAX_POST_BODY) {
        if (request.body) {
          const reader = request.body.getReader();
          try {
            await drainStream(reader);
          } finally {
            reader.releaseLock();
          }
        }
        return proxyError(413, 'PAYLOAD_TOO_LARGE', proxyCors);
      }
    }

    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let oversized = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_POST_BODY) {
            oversized = true;
            await drainStream(reader);
            break;
          }
          chunks.push(value);
        }
      } catch {
        if (!oversized) {
          return proxyError(400, 'BAD_REQUEST', proxyCors);
        }
      } finally {
        reader.releaseLock();
      }

      if (oversized) {
        return proxyError(413, 'PAYLOAD_TOO_LARGE', proxyCors);
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bodyBytes = merged;
    }
  }

  // Headers forwarding
  const upstreamHeaders = new Headers();
  for (const name of FORWARD_HEADERS) {
    const val = request.headers.get(name);
    if (val !== null) {
      upstreamHeaders.set(name, val);
    }
  }

  if (isAgent) {
    upstreamHeaders.set('User-Agent', ANIXART_APP_USER_AGENT);
  }

  // Upstream timeout & signal linking
  let signal: AbortSignal;
  try {
    signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  } catch {
    signal = AbortSignal.timeout(15_000);
  }

  let currentUrl = targetUrl;
  let redirectCount = 0;
  const maxRedirects = 5;
  const visitedUrls = new Set<string>([currentUrl.toString()]);
  let upstreamResponse: Response;

  while (true) {
    const upstreamRequest = new Request(currentUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: bodyBytes ?? undefined,
      redirect: 'manual',
      signal,
    });

    try {
      const hopHostname = currentUrl.hostname.toLowerCase();
      const testFetcher = (hopHostname === 'api-s.anixsekai.com' ? env.ANIXART_TEST : undefined)
        ?? env.PROXY_TEST
        ?? (hopHostname === 'kodikplayer.com' ? env.KODIK_TEST : undefined);

      if (testFetcher) {
        upstreamResponse = await testFetcher.fetch(upstreamRequest);
      } else {
        upstreamResponse = await fetch(upstreamRequest);
      }
    } catch (err: unknown) {
      const errorName = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : '';
      const reasonName = signal.aborted && signal.reason && typeof signal.reason === 'object' && 'name' in signal.reason ? (signal.reason as { name: string }).name : '';
      if (errorName === 'TimeoutError' || reasonName === 'TimeoutError') {
        return proxyError(504, 'UPSTREAM_TIMEOUT', proxyCors);
      }
      return proxyError(502, 'UPSTREAM_ERROR', proxyCors);
    }

    const isRedirect = [301, 302, 303, 307, 308].includes(upstreamResponse.status) ||
      (upstreamResponse.type as string) === 'opaqueredirect';

    if (!isRedirect) {
      break;
    }

    // Agent / API POST protection: no mutation retries/replays
    if (request.method === 'POST') {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    if ((upstreamResponse.type as string) === 'opaqueredirect') {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    const locationHeader = upstreamResponse.headers.get('location');
    if (!locationHeader) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    redirectCount++;
    if (redirectCount > maxRedirects) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(locationHeader, currentUrl);
    } catch {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    if (
      nextUrl.protocol !== 'https:' ||
      nextUrl.username ||
      nextUrl.password ||
      (nextUrl.port !== '' && nextUrl.port !== '443')
    ) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    const nextHostname = nextUrl.hostname.toLowerCase();
    const currentHostname = currentUrl.hostname.toLowerCase();

    // Cross-host agent redirects must stay blocked
    if (isAgent && nextHostname !== currentHostname) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    // Approved destination policy
    if (!isApprovedRedirectDestination(nextHostname)) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }

    // Prevent redirect loops
    const nextUrlStr = nextUrl.toString();
    if (visitedUrls.has(nextUrlStr)) {
      return proxyError(502, 'PROXY_REDIRECT_BLOCKED', proxyCors);
    }
    visitedUrls.add(nextUrlStr);

    currentUrl = nextUrl;
  }

  // Upstream server errors return fixed error codes without leaking details
  if (upstreamResponse.status === 504) {
    return proxyError(504, 'UPSTREAM_TIMEOUT', proxyCors);
  }
  if (upstreamResponse.status >= 500) {
    return proxyError(502, 'UPSTREAM_ERROR', proxyCors);
  }

  // Build stream response
  const responseHeaders = new Headers();
  for (const name of COPY_RESPONSE_HEADERS) {
    const val = upstreamResponse.headers.get(name);
    if (val !== null) {
      responseHeaders.set(name, val);
    }
  }

  responseHeaders.set('X-Upstream-URL', currentUrl.toString());

  if (currentUrl.hostname.toLowerCase() === 'api-s.anixsekai.com' || isAgent) {
    responseHeaders.set('Cache-Control', 'no-store');
  } else {
    const cc = upstreamResponse.headers.get('cache-control');
    if (cc !== null) {
      responseHeaders.set('Cache-Control', cc);
    }
  }

  for (const [name, val] of Object.entries(proxyCors)) {
    responseHeaders.set(name, val);
  }

  const responseBody = (upstreamResponse.status === 204 || upstreamResponse.status === 304 || request.method === 'HEAD' || !upstreamResponse.body)
    ? null
    : upstreamResponse.body;

  return new Response(responseBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
