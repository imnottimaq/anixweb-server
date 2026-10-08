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
