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

test('real browser attachments: native image and voice delivery, history, host close and storage erasure', { timeout: 150000 }, async () => {
    let mf, vite, browser, cacheDirectory;
    const failures = [];
    try {
        const port = await getFreePort();
        cacheDirectory = await mkdtemp(join(tmpdir(), 'anixweb-attachments-vite-'));
        const origin = `http://127.0.0.1:${port}`;
        const video = await fixtureVideo();
        const bundle = await build({ stdin: { contents: `import worker, {RoomObject as Base, RoomDirectory} from './src/worker.ts'; export default worker; export {RoomDirectory}; export class InspectableRoomObject extends Base { constructor(ctx,env){super(ctx,env);this.inspectionContext=ctx;} async fetch(request){ if(new URL(request.url).pathname==='/__test-storage'){return Response.json({keys:[...(await this.inspectionContext.storage.list()).keys()]});} return super.fetch(request);}}`, resolveDir: process.cwd(), sourcefile: 'attachments-test-worker.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
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
                ROOMS: { className: 'InspectableRoomObject', useSQLite: true },
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
        console.log('Attachments Browser fixture Worker:', backend);

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

        browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

        async function viewer(id) {
            const context = await browser.newContext({ permissions: ['microphone'] });
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

        await h.page.goto(`${origin}/together`);
        await h.page.getByRole('button', { name: 'Create room', exact: true }).click();
        const dialog = h.page.getByRole('dialog', { name: 'New room' });
        await dialog.getByRole('textbox').fill('Attachment Test Room');
        await dialog.getByRole('button', { name: 'Create room', exact: true }).click();
        await waitFor(() => h.state()?.participants.some(p => p.profileId === 1 && p.connected), 'host connected');
        const {roomId, joinCode} = h.state();
        await g.page.goto(`${origin}/together/${roomId}?code=${joinCode}`);
        await waitFor(() => g.state()?.participants.some(p => p.profileId === 2 && p.connected), 'guest connected');
        const epoch = h.state().syncEpoch;
        // Canvas encodes a real image; exercise the actual file picker and raw upload.
        const png = await h.page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#8c54ff'; ctx.fillRect(0, 0, 32, 32);
            return canvas.toDataURL('image/png').split(',')[1];
        });
        const picker = h.page.waitForEvent('filechooser');
        await h.page.getByRole('button', {name: 'Attach image', exact: true}).click();
        await (await picker).setFiles({name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')});
        await h.page.getByRole('textbox', {name: 'Chat', exact: true}).fill('Real image caption');
        await h.page.getByRole('button', {name: 'Send', exact: true}).click();
        await waitFor(() => g.state()?.chat?.some(m => m.attachment?.kind === 'image'), 'guest receives image');
        await g.page.getByRole('log').scrollIntoViewIfNeeded();
        const imageMessage = g.state().chat.find(m => m.attachment?.kind === 'image');
        assert.equal(imageMessage.profileId, 1);
        assert.equal(imageMessage.text, 'Real image caption');
        await waitFor(() => g.page.locator('img').evaluateAll(images => images.some(img => img.src.startsWith('blob:') && img.naturalWidth === 32)), 'guest decodes authenticated image');
        await h.page.getByRole('button', {name: 'Voice message', exact: true}).click();
        await h.page.getByRole('button', {name: 'Stop recording', exact: true}).waitFor();
        await delay(1600);
        await h.page.getByRole('button', {name: 'Stop recording', exact: true}).click();
        await expect(h.page.getByRole('button', {name: 'Send voice message', exact: true})).toBeEnabled();
        await h.page.getByRole('button', {name: 'Send voice message', exact: true}).click();
        await waitFor(() => g.state()?.chat?.some(m => m.attachment?.kind === 'voice'), 'guest receives native voice recording');
        const voiceMessage = g.state().chat.find(m => m.attachment?.kind === 'voice');
        assert.ok(voiceMessage.attachment.size > 0 && voiceMessage.attachment.size <= 5_000_000);
        const audio = g.page.locator('audio').first();
        await audio.waitFor();
        await audio.evaluate(element => element.play());
        await waitFor(() => audio.evaluate(element => element.currentTime > 0), 'native audio playback advances');
        assert.equal(h.state().syncEpoch, epoch, 'attachments do not affect playback synchronization');
        g.snapshots.length = 0;
        await g.page.reload();
        await waitFor(() => g.state()?.chat?.filter(m => m.attachment).length === 2, 'attachments restored after reconnect');
        await g.page.getByRole('log').scrollIntoViewIfNeeded();
        await waitFor(() => g.page.locator('img').evaluateAll(images => images.some(img => img.src.startsWith('blob:') && img.naturalWidth === 32)), 'image restored after reload');
        async function assertComposerFits(page) {
            const overflow = await page.getByRole('textbox', {name:'Chat',exact:true}).evaluate(input => {
                const panel = input.closest('aside').getBoundingClientRect();
                return [...input.closest('form').querySelectorAll('button')].filter(button=>{
                    const rect=button.getBoundingClientRect();return rect.width>0 && rect.height>0 && (rect.right>panel.right+1 || rect.left<panel.left-1);
                }).map(button=>button.getAttribute('aria-label')||button.textContent.trim());
            });
            assert.deepEqual(overflow, [], 'chat attachment buttons fit inside room panel');
        }
        await assertComposerFits(g.page);
        await g.page.setViewportSize({width:390,height:844});
        await g.page.getByRole('textbox',{name:'Chat',exact:true}).scrollIntoViewIfNeeded();
        await assertComposerFits(g.page);
        await g.page.setViewportSize({width:1280,height:720});
        await g.page.getByRole('log').scrollIntoViewIfNeeded();
        await mkdir(join(clientRoot, 'test-results'), {recursive: true});
        await g.page.screenshot({path: join(clientRoot, 'test-results', 'watch-room-attachments.png')});
        const sessionResponse = await fetch(`${backend}/api/v2/session`, {method: 'POST', headers: {'content-type':'application/json', origin}, body: JSON.stringify({token:'1', profileId: 1})});
        assert.equal(sessionResponse.status, 200);
        const session = await sessionResponse.json();
        const auth = {authorization: `Bearer ${session.session}`, origin};
        const imageUrl = `${backend}/api/v2/rooms/${roomId}/attachments/${imageMessage.attachment.id}`;
        assert.equal((await fetch(imageUrl, {headers:auth})).status, 200);
        assert.equal((await fetch(imageUrl, {headers:{origin}})).status, 401, 'anonymous files are private');
        const outsiderSession = await (await fetch(`${backend}/api/v2/session`, {method:'POST', headers:{'content-type':'application/json',origin}, body:JSON.stringify({token:'99', profileId: 99})})).json();
        assert.equal((await fetch(imageUrl, {headers:{authorization:`Bearer ${outsiderSession.session}`,origin}})).status, 403, 'unjoined account cannot fetch files');
        assert.equal((await fetch(`${backend}/api/v2/rooms/${roomId}/attachments`, {method:'POST', headers:{...auth, 'content-type':'image/svg+xml','X-Attachment-Kind':'image','X-Attachment-Name':'unsafe.svg','X-Attachment-Upload-Id':crypto.randomUUID()},body:'<svg xmlns="http://www.w3.org/2000/svg" />'})).status, 415, 'active image format rejected');
        const maxImage = Buffer.alloc(5_000_000); Buffer.from(png,'base64').copy(maxImage);
        const uploadKey = crypto.randomUUID();
        const largeHeaders = {...auth,'content-type':'image/png','X-Attachment-Kind':'image','X-Attachment-Name':'boundary.png','X-Attachment-Text':'Boundary','X-Attachment-Upload-Id':uploadKey};
        const attachmentEndpoint = `${backend}/api/v2/rooms/${roomId}/attachments`;
        const boundaryResponse = await fetch(attachmentEndpoint, {method:'POST',headers:largeHeaders,body:maxImage});
        assert.equal(boundaryResponse.status, 200, 'exact decimal 5 MB accepted');
        const boundaryMessage = (await boundaryResponse.json()).message;
        const retryResponse = await fetch(attachmentEndpoint, {method:'POST',headers:largeHeaders,body:maxImage});
        assert.equal(retryResponse.status, 200, 'identical upload retry succeeds');
        assert.equal((await retryResponse.json()).message.id, boundaryMessage.id, 'retry returns same message');
        assert.equal((await fetch(attachmentEndpoint, {method:'POST',headers:{...largeHeaders,'X-Attachment-Text':'Different'},body:maxImage})).status, 409, 'conflicting caption cannot reuse upload receipt');
        const tooLarge = await fetch(attachmentEndpoint, {method:'POST',headers:{...largeHeaders,'X-Attachment-Upload-Id':crypto.randomUUID()},body:Buffer.alloc(5_000_001)});
        assert.equal(tooLarge.status, 413, '5 MB plus one byte rejected');
        assert.equal((await tooLarge.json()).code, 'BODY_TOO_LARGE', 'oversize response body remains readable');
        const storedImage = await fetch(`${attachmentEndpoint}/${boundaryMessage.attachment.id}`, {headers:auth});
        assert.equal(storedImage.headers.get('content-type'), 'image/png');
        assert.equal(storedImage.headers.get('cache-control'), 'no-store');
        assert.equal(storedImage.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await storedImage.arrayBuffer()), maxImage, 'full 5 MB reconstructs across SQLite chunks');
        const ns = await mf.getDurableObjectNamespace('ROOMS');
        const stub = ns.get(ns.idFromName(roomId));
        const keysBefore = await (await stub.fetch('https://internal/__test-storage')).json();
        assert.ok(keysBefore.keys.length > 1, 'actual room storage contains uploaded bytes before closure');
        await expect(g.page.getByRole('button', {name:'Close room', exact:true})).toHaveCount(0);
        await h.page.getByRole('button', {name:'Close room', exact:true}).click();
        const closeDialog = h.page.getByRole('dialog');
        await closeDialog.getByRole('button', {name:'Close room', exact:true}).click();
        await waitFor(async () => (await fetch(imageUrl, {headers:auth})).status === 410, 'closed room rejects attachment reads');
        await waitFor(async () => {
            const stored = await (await stub.fetch('https://internal/__test-storage')).json();
            return stored.keys.length === 1 && stored.keys[0] === 'closed';
        }, 'actual SQLite storage erased with only closed tombstone retained');
        assert.equal((await fetch(`${backend}/api/v2/rooms/${roomId}/attachments`, {method:'POST', headers:{...auth,'content-type':'image/png','X-Attachment-Kind':'image','X-Attachment-Name':'test.png','X-Attachment-Upload-Id':crypto.randomUUID()},body:Buffer.from(png,'base64')})).status, 410, 'closed room cannot accept/recreate files');
        assert.deepEqual(failures, [], 'no uncaught browser errors');
        console.log('Native recording, image delivery, reconnect and physical storage deletion verified');
    } finally {
        await browser?.close();
        await vite?.close();
        await mf?.dispose();
        if (cacheDirectory && resolve(dirname(cacheDirectory)) === resolve(tmpdir()) && basename(cacheDirectory).startsWith('anixweb-attachments-vite-')) {
            await rm(cacheDirectory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
        }
    }
});

