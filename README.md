# anixweb-server

Server-authoritative watch rooms for the Anixweb v2 client. Cloudflare Workers handles HTTP authentication; one SQLite-backed Durable Object coordinates each room using the WebSocket Hibernation API. A separate directory resolves invitation codes, lists public rooms and applies request limits.

## Local development

Requires Node.js 24 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace SESSION_SECRET with a cryptographically random secret (32+ characters).
npm run dev
```

The Worker listens on port 8787. Set `VITE_ROOM_SERVER_URL=http://localhost:8787` in the sibling Anixweb client's local environment. `ALLOWED_ORIGINS` is a comma-separated exact allowlist; local ports 5173 are configured by default. WebSocket upgrades require an allowed Origin. Never use `*` for a production origin.

Run `npm test` and `npm run build` before shipping. Tests execute the actual bundled Worker and SQLite Durable Objects in Miniflare/workerd with an upstream authentication fixture. Room-domain tests use controlled clocks; external Anixart availability and hardware video playback are separate checks.

For an actual two-browser playback test, keep the client checkout beside this repository, run `npm ci` and `npx playwright install chromium` in the client, then run `npm run test:browser` here. The test starts its own local Worker and Vite servers, uses two independent browser profiles and real MP4/HLS media, and verifies the seven-second deadline, catch-up, UI pause, local quality switching, private-room refresh and host transfer. It fixtures only the external Anixart/media-discovery endpoints; room authentication/session issuance, WebSockets, SQLite state and video playback are real. Port 5173 must be free. A public W3C MP4 and three segments from the public hls.js/Mux demonstration stream are cached in the system temporary directory on first run; `ANIXWEB_TEST_VIDEO` can point to an existing local MP4. Screenshots are written to ignored `test-results/`.

## Contract

`protocol/index.ts` is the canonical shared contract. Run `npm run sync:protocol` to vendor it into the sibling client after contract changes. HTTP endpoints are prefixed `/api/v2`:

| Method and endpoint | Request | Response |
| --- | --- | --- |
| POST `/session` | `{token}` Anixart token | `{session,expiresAt,profile}` |
| POST `/rooms` | Bearer session; `{title,visibility}` | `{roomId,ticket,state}` |
| GET `/rooms?cursor=…` | Optional opaque cursor | `{rooms,cursor}`; up to 20 public rooms |
| POST `/rooms/join` | Bearer session; `{roomId}` or `{code}` | `{roomId,ticket,state}` |
| GET `/rooms/:roomId/ws?ticket=…` | WebSocket upgrade; allowed Origin | WebSocket v2 messages |

Sessions are signed for 15 minutes. The Anixart token is sent only to the fixed HTTPS `/profile/info` upstream with User-Agent `AnixartApp`; it is never stored in the room, signed session or logs. Upstream errors return `AUTH_UNAVAILABLE` (503) except explicit HTTP 401 (`AUTH_REJECTED`). No error instructs the client to erase its Anixart credentials. `ANIXART_TEST` is an optional service binding used only by integration tests; no production URL override exists.

Connection tickets are random, single-use and expire after 30 seconds. Private rooms require an invitation code unless the verified account is already admitted. Each account has one active connection; a replacement closes the old one with `session_replaced` and old close events cannot change replacement presence. Profile identity and all permissions are checked on the server.

Commands include `commandId` and `mediaVersion`. Successful commands are durably stored before acknowledgement and snapshots. The engine rejects stale media, invalid values and unauthorized commands, and remembers command IDs for deduplication. HTTP errors contain `{code,message}`; WebSocket failures use the shared `error` message.

## Lifecycle

Playback uses a server time anchor, shared media, rate and user intent. Readiness refers to the current synchronization epoch. When an active viewer buffers, everyone waits up to 7 seconds; ready viewers continue afterward, while a late viewer remains admitted and catches up. User Pause cancels automatic resumption. Late viewers do not repeatedly interrupt the same loading epoch.

Clients ping every 5 seconds. The server detects silent socket loss after 15 seconds; the disconnected host then has 7 seconds to reconnect before a random connected participant takes over. Explicit host leave transfers immediately. Empty rooms close after 10 minutes. Durable alarms preserve deadlines across hibernation and remove expired connection tickets and invitation reservations. Directory update failures retry without invalidating committed room state.

Rooms and sockets are v2 only. Legacy endpoints/active rooms are not migrated. Quality, audio level, frame mode and Anime4K are client-local.

## Deployment

Set production `ALLOWED_ORIGINS` to the deployed client's exact origin, run `npx wrangler secret put SESSION_SECRET`, then deploy with `npx wrangler deploy` after staging checks. The first deployment applies the `v1` SQLite class migration. Configure the client with the HTTPS Worker URL. No deployment is performed by repository setup or CI.

Worker observability is disabled by default because connection tickets appear in WebSocket URLs. Before enabling request logging, configure redaction for `ticket`, `Authorization`, and upstream token query parameters; never record authentication request bodies. Rotate `SESSION_SECRET` to revoke all room sessions. Rate limits are 30 auth attempts/IP/minute, 5 room creations/account/minute, 30 joins/account/minute, and 100 socket messages/10 seconds.

Structured business events are available through `wrangler tail`: HTTP/command rejection codes, connection/disconnection, readiness timeout, host change and room closure. They include room IDs and fixed reason codes only; no identities, request URLs, raw messages or credentials. Output is capped at 60 events per isolate per minute to bound abusive logging. Request observability remains disabled independently.

Cloudflare references: [Hibernation WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
