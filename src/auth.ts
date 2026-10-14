import type { Profile } from '../protocol/index.ts';
import { ANIXART_APP_USER_AGENT } from './userAgent.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export interface AuthEnv { SESSION_SECRET: string; ANIXART_TEST?: Fetcher }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret: string) {
  if (!secret || secret.length < 32) throw new HttpError(503, 'SERVER_NOT_CONFIGURED');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signSession(profile: Profile, env: AuthEnv, now = Date.now()) {
  const expiresAt = now + 900_000;
  const payload = encode(new TextEncoder().encode(JSON.stringify({ profile, expiresAt })));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.SESSION_SECRET), new TextEncoder().encode(payload))));
  return { session: `${payload}.${signature}`, expiresAt, profile };
}
export async function verifySession(request: Request, env: AuthEnv, now = Date.now()): Promise<Profile> {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token || token.length > 5000) throw new HttpError(401, 'SESSION_REQUIRED');
  const signingKey = await key(env.SESSION_SECRET);
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra || !payload || !signature || !await crypto.subtle.verify('HMAC', signingKey, decode(signature), new TextEncoder().encode(payload))) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (data.expiresAt <= now || !Number.isSafeInteger(data.profile?.profileId) || data.profile.profileId <= 0 || typeof data.profile.login !== 'string') throw new Error();
    return data.profile;
  } catch { throw new HttpError(401, 'SESSION_INVALID'); }
}
export async function authenticate(token: unknown, profileId: unknown, env: AuthEnv): Promise<Profile> {
  if (typeof token !== 'string' || !token || token.length > 4096) throw new HttpError(400, 'INVALID_TOKEN');
  const candidateId = Number(profileId);
  if (typeof profileId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId <= 0) throw new HttpError(400, 'INVALID_PROFILE_ID');
  const url = new URL(`https://api-s.anixsekai.com/profile/${candidateId}`);
  url.searchParams.set('token', token);
  try {
    const request = new Request(url, { headers: { 'User-Agent': ANIXART_APP_USER_AGENT }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    const response = env.ANIXART_TEST ? await env.ANIXART_TEST.fetch(request) : await fetch(request);
    // Explicit HTTP 401 indicates invalid credentials, genuine outage/network error is 503.
    if (response.status === 401) throw new HttpError(401, 'AUTH_REJECTED');
    if (!response.ok) throw new HttpError(503, 'AUTH_UNAVAILABLE');
    const data = await response.json() as {
      code?: unknown;
      is_my_profile?: unknown;
      profile?: { id?: unknown; login?: unknown; avatar?: unknown };
    };
    // Safe synthetic invalid token returns HTTP 200 with code 401
    if (data.code === 401) throw new HttpError(401, 'AUTH_REJECTED');
    if (data.code !== 0) throw new HttpError(503, 'AUTH_UNAVAILABLE');
    // Ownership flag is required and must be explicitly true
    if (data.is_my_profile !== true) throw new HttpError(401, 'AUTH_REJECTED');
    const p = data.profile;
    if (!p || typeof p !== 'object') throw new HttpError(503, 'AUTH_UNAVAILABLE');
    const upstreamId = Number(p.id);
    if (!Number.isSafeInteger(upstreamId) || upstreamId <= 0 || upstreamId !== candidateId) {
      throw new HttpError(401, 'AUTH_REJECTED');
    }
    if (typeof p.login !== 'string' || !p.login.trim() || p.login.length > 100) {
      throw new HttpError(503, 'AUTH_UNAVAILABLE');
    }
    return {
      profileId: upstreamId,
      login: p.login,
      avatar: typeof p.avatar === 'string' && p.avatar.length > 0 && p.avatar.length <= 2048 ? p.avatar : null,
    };
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'AUTH_UNAVAILABLE'); }
}
