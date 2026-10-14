import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const clientRoot = fileURLToPath(new URL('../../anixweb/', import.meta.url));
const requireClient = createRequire(join(clientRoot, 'package.json'));
const { chromium, expect } = requireClient('@playwright/test');
const { createServer } = await import(pathToFileURL(requireClient.resolve('vite')).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createNetServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(err => {
                if (err) reject(err);
                else resolve(port);
            });
        });
        srv.on('error', reject);
    });
}

async function fixtureVideo() {
    const directory = join(tmpdir(), 'anixweb-browser-fixtures');
    await mkdir(directory, { recursive: true });
    const path = process.env.ANIXWEB_TEST_VIDEO || join(directory, 'trailer.mp4');
    try {
        return await readFile(path);
    } catch {
        const response = await fetch('https://media.w3.org/2010/05/sintel/trailer.mp4');
        if (!response.ok) throw new Error('Could not download the public W3C MP4 fixture');
        const video = Buffer.from(await response.arrayBuffer());
        await writeFile(path, video);
        return video;
    }
}

test('real browser social: host/member exchange messages, live reactions, late join/reconnect history, unaffected playback', { timeout: 150000 }, async () => {
    let mf, vite, browser, cacheDirectory;
    const failures = [];
    try {
        const port = await getFreePort();
        cacheDirectory = await mkdtemp(join(tmpdir(), 'anixweb-social-vite-'));
        const origin = `http://127.0.0.1:${port}`;
        const video = await fixtureVideo();
        const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
        mf = new Miniflare(convertV4MiniflareOptions({
            modules: true,
            script: bundle.outputFiles[0].text,
            compatibilityDate: '2026-10-07',
            port: 0,
            bindings: {
                SESSION_SECRET: 'browser-fixture-secret-at-least-thirty-two-characters',
                ALLOWED_ORIGINS: origin,
            },
            durableObjects: {
                ROOMS: { className: 'RoomObject', useSQLite: true },
                DIRECTORY: { className: 'RoomDirectory', useSQLite: true },
            },
            serviceBindings: {
                ANIXART_TEST: async request => {
                    const url = new URL(request.url);
                    const path = url.pathname;
                    if (path.startsWith('/episode/')) {
                        return Response.json({
                            code: 0,
                            episodes: [
                                { position: 1, name: 'First episode', url: 'https://aniliberty.top/?id=1&ep=1' },
                            ],
                        });
                    }
                    const token = url.searchParams.get('token');
                    if (path === '/profile/info') {
                        return Response.json({ code: 0, channel_id: null, privilege_level: 0, rating_score: 0, sponsorship_expires: 0, is_perm_banned: false, is_sponsor: false });
                    }
                    if (path.startsWith('/profile/')) {
                        const profileId = Number(path.replace('/profile/', ''));
                        const isOwner = token === String(profileId);
                        return Response.json({
                            code: 0,
                            is_my_profile: isOwner,
                            profile: { id: profileId, login: `viewer${profileId}`, avatar: null }
                        });
                    }
                    return Response.json({ code: 0, content: [], releases: [], total_page_count: 0 });
                },
            },
        }));
        const backend = (await mf.ready).origin;
        console.log('Social Browser fixture Worker:', backend);

        process.env.VITE_ROOM_SERVER_URL = backend;
        process.env.VITE_PROXY_SERVER_URL = backend;

        vite = await createServer({
            root: clientRoot,
            cacheDir: cacheDirectory,
            define: {
                'import.meta.env.VITE_ROOM_SERVER_URL': JSON.stringify(backend),
                'import.meta.env.VITE_PROXY_SERVER_URL': JSON.stringify(backend),
            },
            server: { host: '127.0.0.1', port, strictPort: true },
            plugins: [{
                name: 'real-video-fixture',
                configureServer(server) {
                    server.middlewares.use((request, response, next) => {
                        if (request.url?.startsWith('/anixweb/')) {
                            request.url = request.url.replace(/^\/anixweb\//, '/');
                        }
                        if (!request.url?.startsWith('/__fixtures__/video.mp4')) { next(); return; }
                        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
                        const start = range ? Number(range[1]) : 0;
                        const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
                        response.statusCode = range ? 206 : 200;
                        response.setHeader('Content-Type', 'video/mp4');
                        response.setHeader('Accept-Ranges', 'bytes');
                        response.setHeader('Content-Length', end - start + 1);
                        if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${video.length}`);
                        response.end(video.subarray(start, end + 1));
                    });
                },
            }],
        });
        await vite.listen();

        browser = await chromium.launch({ headless: true });

        async function viewer(id) {
            const context = await browser.newContext();
            await context.addCookies([{ name: 'anixart_token', value: String(id), url: origin }]);
            await context.addInitScript(({ id }) => {
                localStorage.setItem('onboarded', 'true');
                localStorage.setItem('user_id', String(id));
                localStorage.setItem('user_room_identity', JSON.stringify({ id, login: `viewer${id}`, avatar: null }));
                localStorage.setItem('app_settings', JSON.stringify({ appearance: { language: 'english', theme: 'light' }, player: { volume: 0, autoplay: false } }));
                const Socket = window.WebSocket;
                window.WebSocket = class extends Socket {
                    constructor(...args) {
                        super(...args);
                        window.__roomSocket = this;
                    }
                };
            }, { id });

            await context.route('https://api-s.anixsekai.com/**', async route => {
                try {
                    const targetUrl = route.request().url();
                    const proxyUrl = `${backend}/corsproxy?url=${encodeURIComponent(targetUrl)}`;
                    const headers = new Headers(route.request().headers());
                    headers.delete('host');
                    headers.set('origin', origin);
                    const response = await fetch(proxyUrl, {
                        method: route.request().method(),
                        headers,
                        body: route.request().postDataBuffer() ?? undefined,
                    });
                    const body = await response.arrayBuffer();
                    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(body) });
                } catch {
                    await route.abort().catch(() => {});
                }
            });

            await context.route('https://aniliberty.top/**', route => route.fulfill({
                json: {
                    episodes: [{ ordinal: 1, hls_1080: `${origin}/__fixtures__/video.mp4?quality=1080&episode=1`, hls_720: null, hls_480: null }],
                },
            }));

            const page = await context.newPage();
            const snapshots = [];
            const reactionsReceived = [];
            page.on('pageerror', error => failures.push(error.message));
            page.on('websocket', socket => socket.on('framereceived', event => {
                try {
                    const message = JSON.parse(event.payload.toString());
                    if (message.type === 'room_state') snapshots.push(message.state);
                    if (message.type === 'reaction') reactionsReceived.push(message.reaction);
                } catch { /* ignore non-JSON */ }
            }));
            const state = () => snapshots.at(-1);
            return { page, context, state, snapshots, reactionsReceived };
        }

        const h = await viewer(1); // Host (viewer1)
        const g = await viewer(2); // Guest (viewer2)

        // 1. Host creates room
        await h.page.goto(`${origin}/together`);
        await h.page.getByRole('button', { name: 'Create room', exact: true }).click();
        const createDialog = h.page.getByRole('dialog', { name: 'New room' });
        await createDialog.waitFor();
        await createDialog.getByRole('textbox').fill('Social Test Room');
        await createDialog.getByRole('button', { name: 'Create room', exact: true }).click();

        await waitFor(() => h.state()?.participants.some(p => p.profileId === 1 && p.connected), 'host connected');
        const roomId = h.state().roomId;
        const code = h.state().joinCode;
        console.log('Social fixture: room created', roomId);

        // 2. Guest joins room
        await g.page.goto(`${origin}/together/${roomId}?code=${code}`);
        await waitFor(() => g.state()?.participants.some(p => p.profileId === 2 && p.connected), 'guest connected');
        console.log('Social fixture: guest connected');

        // 3. Host sends chat message via UI
        const hostChatInput = h.page.locator('textarea[data-testid="chat-input"]').or(h.page.getByPlaceholder(/message|сообщение/i));
        await hostChatInput.waitFor({ timeout: 10000 });
        await hostChatInput.fill('Hello from host!');
        await hostChatInput.press('Enter');

        // Verify message appears on host and guest
        await waitFor(() => h.state()?.chat?.some(m => m.text === 'Hello from host!' && m.profileId === 1), 'host chat in state');
        await waitFor(() => g.state()?.chat?.some(m => m.text === 'Hello from host!' && m.profileId === 1), 'guest receives host chat');
        await expect(g.page.getByText('Hello from host!')).toBeVisible();

        // 4. Guest replies
        const guestChatInput = g.page.locator('textarea[data-testid="chat-input"]').or(g.page.getByPlaceholder(/message|сообщение/i));
        await guestChatInput.fill('Hey host!');
        await guestChatInput.press('Enter');

        await waitFor(() => h.state()?.chat?.some(m => m.text === 'Hey host!' && m.profileId === 2), 'host receives guest chat');
        await expect(h.page.getByText('Hey host!')).toBeVisible();
        console.log('Social fixture: 2-way chat verified');

        // 5. Host sends reaction via UI button
        const heartButton = h.page.getByRole('button', { name: 'Heart' });
        await heartButton.waitFor({ timeout: 10000 });
        await heartButton.click();

        await waitFor(() => g.reactionsReceived.some(r => r.emoji === 'heart' && r.profileId === 1), 'guest received live heart reaction');
        const guestReactionBubble = g.page.locator('[data-testid="reaction-bubble"]');
        await expect(guestReactionBubble.first()).toBeVisible({ timeout: 5000 });
        await expect(guestReactionBubble).toHaveCount(0, { timeout: 8000 });
        console.log('Social fixture: live emoji reaction fanout, UI overlay, and expiry verified');

        // 6. Late joiner (viewer 3) gets bounded chat history but NOT expired reactions
        const late = await viewer(3);
        await late.page.goto(`${origin}/together/${roomId}?code=${code}`);
        await waitFor(() => late.state()?.participants.some(p => p.profileId === 3 && p.connected), 'late viewer connected');

        // Verify chat history restored to late joiner
        await waitFor(() => late.state()?.chat?.length >= 2, 'late joiner chat history restored');
        assert.ok(late.state().chat.some(m => m.text === 'Hello from host!'), 'history has first message');
        assert.ok(late.state().chat.some(m => m.text === 'Hey host!'), 'history has second message');
        // Late joiner should NOT receive reactions that occurred before join
        assert.equal(late.reactionsReceived.length, 0, 'late joiner does not receive expired past reactions');
        console.log('Social fixture: late joiner history and expired reaction immunity verified');

        // 7. Open player for host and guest
        await h.page.goto(`${origin}/anime/10/watch?room=${roomId}`);
        await g.page.goto(`${origin}/anime/10/watch?room=${roomId}`);
        await waitFor(() => h.state()?.participants.filter(p => p.viewing && p.connected).length >= 2, 'both in player');

        // Set media
        await h.page.evaluate(({ mediaVersion }) => window.__roomSocket.send(JSON.stringify({
            type: 'set_media',
            media: { releaseId: 10, releaseName: 'Social fixture', dubId: 20, sourceId: 30, episode: 1, episodeName: 'First episode' },
            commandId: crypto.randomUUID(),
            mediaVersion,
        })), { mediaVersion: h.state().mediaVersion });

        await waitFor(() => h.state()?.participants.find(p => p.profileId === 1)?.status === 'ready', 'host ready in player');
        await waitFor(() => h.state()?.playback.paused === false, 'playback started');
        await waitFor(() => h.page.locator('video').evaluate(video => !video.paused && video.currentTime > 3), 'native playback advances before social commands');

        const initialEpoch = h.state().syncEpoch;

        // Send a chat message while playing - verify playback anchor & epoch NOT mutated!
        await h.page.mouse.move(100, 100);
        await h.page.locator('button[aria-controls="watch-room-panel"]').click();
        await h.page.getByRole('textbox', { name: 'Chat', exact: true }).fill('Watching together!');
        // Native keyboard activation must send chat, without triggering the
        // player's Space shortcut and pausing the entire room.
        await h.page.getByRole('button', { name: 'Send', exact: true }).press('Space');

        await waitFor(() => g.state()?.chat?.some(m => m.text === 'Watching together!'), 'in-player chat received');
        assert.equal(h.state().syncEpoch, initialEpoch, 'syncEpoch untouched by social send');
        assert.equal(h.state().playback.paused, false, 'playback remains playing across chat');

        // Verify video is actively playing on guest
        await waitFor(async () => {
            return await g.page.evaluate(() => {
                const v = document.querySelector('video');
                return Boolean(v && !v.paused && v.currentTime > 0);
            });
        }, 'guest video is actively playing');

        // Send reaction with player sidebar closed - verify floating reaction overlay visible over player
        const beforeReactions = g.reactionsReceived.length;
        await expect(g.page.locator('#watch-room-panel')).toHaveCount(0);
        await h.page.getByRole('button', { name: 'Fire', exact: true }).press('Space');

        await waitFor(() => g.reactionsReceived.length > beforeReactions, 'guest received fire reaction in player');
        const playerReactionBubble = g.page.locator('[data-testid="reaction-bubble"]');
        await expect(playerReactionBubble.first()).toBeVisible({ timeout: 5000 });
        const stillPlaying = await g.page.evaluate(() => {
            const v = document.querySelector('video');
            return Boolean(v && !v.paused);
        });
        assert.ok(stillPlaying, 'video continues playing uninterrupted across reactions');
        await mkdir(join(clientRoot, 'test-results'), { recursive: true });
        await h.page.screenshot({ path: join(clientRoot, 'test-results', 'watch-room-chat.png') });
        await g.page.screenshot({ path: join(clientRoot, 'test-results', 'watch-room-reaction.png') });
        console.log('Social fixture: player playback unaffected and reaction visible in player');

        // 8. Reconnect: clear old buffers before guest refreshes player
        g.snapshots.length = 0;
        g.reactionsReceived.length = 0;
        await g.page.reload();
        await waitFor(() => g.state()?.participants.find(p => p.profileId === 2)?.connected, 'guest reconnected');
        await waitFor(() => g.state()?.chat?.some(m => m.text === 'Watching together!'), 'guest restored chat after reload');
        assert.equal(g.reactionsReceived.length, 0, 'no old/expired reactions replayed after reload');
        console.log('Social fixture: chat history restored after player reload with no expired reactions');

        assert.deepEqual(failures, [], 'no uncaught browser errors');
        console.log('All real browser social integration assertions passed successfully!');

        await late.context.close();
        await g.context.close();
        await h.context.close();
    } finally {
        await browser?.close();
        await vite?.close();
        await mf?.dispose();
        if (cacheDirectory && resolve(dirname(cacheDirectory)) === resolve(tmpdir()) && basename(cacheDirectory).startsWith('anixweb-social-vite-')) {
            await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }
});
