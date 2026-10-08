import { authenticate, HttpError, signSession, verifySession } from './auth.ts';
import { businessLog } from './logging.ts';
import { handleProxyRequest } from './proxy.ts';
export { RoomObject, RoomDirectory } from './objects.ts';
export interface Env {
  ROOMS: DurableObjectNamespace; DIRECTORY: DurableObjectNamespace;
  SESSION_SECRET: string; ALLOWED_ORIGINS: string;
  ANIXART_TEST?: Fetcher; PROXY_TEST?: Fetcher; KODIK_TEST?: Fetcher;
}
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function body(request: Request) {
  if (Number(request.headers.get('Content-Length')) > 8192) throw new HttpError(413, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new HttpError(400, 'INVALID_BODY'); }
}
function directory(env: Env) { return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory-v2')); }
async function internal(stub: DurableObjectStub, path: string, data?: unknown) {
  const response = await stub.fetch(new Request(`https://internal${path}`, data === undefined ? undefined : { method: 'POST', body: JSON.stringify(data) }));
  if (!response.ok) { const result = await response.json() as { code: string }; throw new HttpError(response.status, result.code); }
  return response;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const cors: Record<string, string> = origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
    try {
      if (origin && !allowed.includes(origin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN');
      const url = new URL(request.url), path = url.pathname;
      if (path === '/agentproxy' || path === '/corsproxy') {
        return await handleProxyRequest(request, env);
      }
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'SERVER_NOT_CONFIGURED');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      let response: Response;
      if (path === '/api/v2/session' && request.method === 'POST') {
        await internal(directory(env), '/limit', { key: `auth:${request.headers.get('CF-Connecting-IP') ?? 'local'}`, max: 30 });
        response = json(await signSession(await authenticate((await body(request)).token, env), env));
      } else if (path === '/api/v2/rooms' && request.method === 'GET') {
        response = await internal(directory(env), `/list?cursor=${encodeURIComponent(url.searchParams.get('cursor') ?? '')}`);
      } else if (path === '/api/v2/rooms' && request.method === 'POST') {
        const profile = await verifySession(request, env), data = await body(request);
        if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > 80) throw new HttpError(400, 'INVALID_ROOM');
        if (data.visibility !== 'private' && data.visibility !== 'public') throw new HttpError(400, 'INVALID_PAYLOAD');
        await internal(directory(env), '/limit', { key: `create:${profile.profileId}`, max: 5 });
        const roomId = crypto.randomUUID();
        const reservation = await (await internal(directory(env), '/reserve', { roomId })).json() as { code: string };
        const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        try { await internal(room, '/init', { roomId, joinCode: reservation.code, title: data.title.trim(), visibility: data.visibility, host: profile }); }
        catch (error) { await internal(directory(env), '/remove', { roomId, code: reservation.code }); throw error; }
        response = await internal(room, '/ticket', { profile, code: reservation.code });
      } else if (path === '/api/v2/rooms/join' && request.method === 'POST') {
        const profile = await verifySession(request, env), data = await body(request);
        await internal(directory(env), '/limit', { key: `join:${profile.profileId}`, max: 30 });
        let roomId = data.roomId;
        if (data.code !== undefined) {
          if (typeof data.code !== 'string' || !/^[A-Z2-9]{8}$/.test(data.code.toUpperCase())) throw new HttpError(400, 'INVALID_CODE');
          const lookup = await (await internal(directory(env), `/resolve?code=${data.code.toUpperCase()}`)).json() as { roomId: string };
          roomId = lookup.roomId;
        }
        if (typeof roomId !== 'string' || !/^[a-f0-9-]{36}$/.test(roomId)) throw new HttpError(400, 'INVALID_ROOM');
        response = await internal(env.ROOMS.get(env.ROOMS.idFromName(roomId)), '/ticket', { profile, code: typeof data.code === 'string' ? data.code.toUpperCase() : undefined });
      } else if (/^\/api\/v2\/rooms\/[a-f0-9-]{36}\/ws$/.test(path) && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN');
        response = await env.ROOMS.get(env.ROOMS.idFromName(path.split('/')[4]!)).fetch(new Request(`https://internal/ws?ticket=${encodeURIComponent(url.searchParams.get('ticket') ?? '')}`, request));
        if (response.status >= 400) {
          const failure = await response.clone().json() as { code: string };
          businessLog('http_rejected', { code: failure.code, status: response.status });
        }
        return response;
      } else throw new HttpError(404, 'NOT_FOUND');
      response = new Response(response.body, response);
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR');
      businessLog('http_rejected', { code: failure.code, status: failure.status });
      const response = json({ code: failure.code, message: failure.code }, failure.status);
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
