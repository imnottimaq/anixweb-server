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
const { chromium } = requireClient('@playwright/test');
const { createServer } = await import(pathToFileURL(requireClient.resolve('vite')).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await fn()) return; await delay(100); }
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
    try { return await readFile(path); } catch {
        const response = await fetch('https://media.w3.org/2010/05/sintel/trailer.mp4');
        if (!response.ok) throw new Error('Could not download the public W3C MP4 fixture');
        const video = Buffer.from(await response.arrayBuffer()); await writeFile(path, video); return video;
    }
}
async function fixtureHls() {
    const directory = join(tmpdir(), 'anixweb-browser-fixtures', 'hls');
    await mkdir(directory, { recursive: true });
    const files = new Map();
    const base = 'https://test-streams.mux.dev/x36xhzz/url_6/';
    // Three ten-second segments from the public hls.js demonstration stream.
    for (let index = 0; index < 3; index++) {
        const name = `segment-${index}.ts`, path = join(directory, name);
        let bytes;
        try { bytes = await readFile(path); } catch {
            const response = await fetch(`${base}url_${846 + index}/193039199_mp4_h264_aac_hq_7.ts`);
            if (!response.ok) throw new Error('Could not download HLS media fixture');
            bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path, bytes);
        }
        files.set(name, bytes);
    }
    files.set('playlist.m3u8', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n'
        + Array.from({ length: 3 }, (_, index) => `#EXTINF:10.000,\nsegment-${index}.ts\n`).join('') + '#EXT-X-ENDLIST\n'));
    return files;
}

test('two real browsers: seven-second wait, late catch-up, room controls, navigation and host transfer', { timeout: 150000 }, async () => {
    let mf, vite, browser, releaseGuest, hostPage, cacheDirectory;
    const failures = [];
    try {
        const port = await getFreePort();
        cacheDirectory = await mkdtemp(join(tmpdir(), 'anixweb-playback-vite-'));
        const origin = `http://127.0.0.1:${port}`;
        const video = await fixtureVideo();
        const hls = await fixtureHls();
        const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
        mf = new Miniflare(convertV4MiniflareOptions({
            modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-07', port: 0,
            bindings: { SESSION_SECRET: 'browser-fixture-secret-at-least-thirty-two-characters', ALLOWED_ORIGINS: origin },
            durableObjects: { ROOMS: { className: 'RoomObject', useSQLite: true }, DIRECTORY: { className: 'RoomDirectory', useSQLite: true } },
            serviceBindings: { ANIXART_TEST: async request => {
                const url = new URL(request.url);
                const path = url.pathname;
                if (path.startsWith('/episode/')) {
                    return Response.json({ code: 0, episodes: [
                        { position: 1, name: 'First episode', url: 'https://aniliberty.top/?id=1&ep=1' },
                        { position: 2, name: 'Second episode', url: 'https://aniliberty.top/?id=1&ep=2' },
                    ] });
                }
                const id = Number(url.searchParams.get('token'));
                if (path === '/profile/info') {
                    return Response.json({ code: 0, profile: { id, login: `viewer${id}`, avatar: null } });
                }
                return Response.json({ code: 0, content: [], releases: [], total_page_count: 0 });
            } },
        }));
        const backend = (await mf.ready).origin;
        console.log('Browser fixture Worker:', backend, (await fetch(backend + '/api/v2/rooms')).status);
        process.env.VITE_ROOM_SERVER_URL = backend;
        process.env.VITE_PROXY_SERVER_URL = backend;
        vite = await createServer({ root: clientRoot, cacheDir: cacheDirectory, define: {
            'import.meta.env.VITE_ROOM_SERVER_URL': JSON.stringify(backend),
            'import.meta.env.VITE_PROXY_SERVER_URL': JSON.stringify(backend),
        }, server: { host: '127.0.0.1', port, strictPort: true },
            plugins: [{ name: 'real-video-fixture', configureServer(server) {
                server.middlewares.use((request, response, next) => {
                    if (request.url?.startsWith('/anixweb/')) {
                        request.url = request.url.replace(/^\/anixweb\//, '/');
                    }
                    if (request.url?.startsWith('/__fixtures__/hls/')) {
                        const name = new URL(request.url, origin).pathname.split('/').at(-1);
                        const bytes = hls.get(name);
                        if (!bytes) { response.statusCode = 404; response.end(); return; }
                        response.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
                        response.setHeader('Content-Length', bytes.length); response.end(bytes); return;
                    }
                    if (!request.url?.startsWith('/__fixtures__/video.mp4')) { next(); return; }
                    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
                    const start = range ? Number(range[1]) : 0;
                    const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
                    response.statusCode = range ? 206 : 200;
                    response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Accept-Ranges', 'bytes');
                    response.setHeader('Content-Length', end - start + 1);
                    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${video.length}`);
                    response.end(video.subarray(start, end + 1));
                });
            } }],
        });
        await vite.listen();
        browser = await chromium.launch({ headless: true });
        let holdGuest = true;
        const guestGate = new Promise(resolve => { releaseGuest = resolve; });
        async function viewer(id) {
            const context = await browser.newContext();
            await context.addCookies([{ name: 'anixart_token', value: String(id), url: origin }]);
            await context.addInitScript(({ id }) => {
                localStorage.setItem('onboarded', 'true'); localStorage.setItem('user_id', String(id));
                localStorage.setItem('app_settings', JSON.stringify({ appearance: { language: 'english' }, player: { volume: 0, autoplay: false } }));
                // Observability only: these are real native WebSocket instances.
                const Socket = window.WebSocket;
                window.WebSocket = class extends Socket {
                    constructor(...args) { super(...args); window.__roomSocket = this; }
                };
            }, { id });
            await context.route('https://api-s.anixsekai.com/**', async route => {
                const targetUrl = route.request().url();
                const path = new URL(targetUrl).pathname;
                if (path.startsWith('/episode/') && id === 2 && holdGuest) {
                    await guestGate;
                }
                const { host: _host, origin: _origin, ...forwardHeaders } = route.request().headers();
                const proxyUrl = `${backend}/corsproxy?url=${encodeURIComponent(targetUrl)}`;
                const response = await fetch(proxyUrl, {
                    method: route.request().method(),
                    headers: {
                        ...forwardHeaders,
                        Origin: origin,
                    },
                    body: route.request().postDataBuffer() ?? undefined,
                });
                const body = await response.arrayBuffer();
                const headers = Object.fromEntries(response.headers.entries());
                await route.fulfill({
                    status: response.status,
                    headers,
                    body: Buffer.from(body),
                });
            });
            await context.route('https://aniliberty.top/**', route => route.fulfill({ json: {
                episodes: [1, 2].map(ordinal => ({ ordinal, hls_1080: ordinal === 2 ? `${origin}/__fixtures__/hls/playlist.m3u8?quality=1080` : `${origin}/__fixtures__/video.mp4?quality=1080&episode=${ordinal}`,
                    hls_720: ordinal === 2 ? `${origin}/__fixtures__/hls/playlist.m3u8?quality=720` : `${origin}/__fixtures__/video.mp4?quality=720&episode=${ordinal}`, hls_480: null })),
            } }));
            const page = await context.newPage(); const snapshots = [];
            page.on('pageerror', error => failures.push(error.message));
            page.on('console', message => { if (message.type() === 'error' && message.text().includes('/api/v2/')) console.log('Browser console:', message.text()); });
            page.on('requestfailed', request => { if (request.url().includes('/api/v2/')) console.log('Browser transport failure:', new URL(request.url()).origin, request.failure()?.errorText); });
            page.on('response', response => {
                if (response.url().includes('/api/v2/') && response.status() >= 400) console.log('Browser room API error:', new URL(response.url()).pathname, response.status());
            });
            page.on('websocket', socket => socket.on('framereceived', event => {
                try { const message = JSON.parse(event.payload.toString()); if (message.type === 'room_state') snapshots.push(message.state); } catch { /* non-JSON transport frame */ }
            }));
            const state = () => snapshots.at(-1);
            return { page, context, state, snapshots };
        }
        const h = await viewer(1), g = await viewer(2);
        hostPage = h.page;
        await h.page.goto(`${origin}/together`);
        console.log('Browser API configuration:', await h.page.evaluate(async () => {
            const { getRoomServerUrl } = await import('/src/shared/watchRoom.ts');
            return { base: getRoomServerUrl(), agent: navigator.userAgent };
        }));

        // Current UI: Click Create room button on lobby page
        await h.page.getByRole('button', { name: 'Create room', exact: true }).click();
        const createDialog = h.page.getByRole('dialog', { name: 'New room' });
        await createDialog.waitFor();
        await createDialog.getByRole('textbox').fill('Browser test room');
        await createDialog.getByRole('button', { name: 'Create room', exact: true }).click();

        await waitFor(() => h.state()?.participants.some(p => p.profileId === 1 && p.connected), 'host connected');
        const roomId = h.state().roomId, code = h.state().joinCode;
        console.log('Browser fixture: host created and joined a private room.');
        await g.page.goto(`${origin}/together/${roomId}?code=${code}`);
        await waitFor(() => g.state()?.participants.some(p => p.profileId === 2 && p.connected), 'guest invited');
        await h.page.goto(`${origin}/anime/10/watch?room=${roomId}`);
        await g.page.goto(`${origin}/anime/10/watch?room=${roomId}`);
        await waitFor(() => h.state()?.participants.filter(p => p.viewing && p.connected).length === 2, 'both viewers in the player');
        console.log('Browser fixture: both authenticated viewers opened the player.');
        async function command(viewer, payload) {
            await viewer.page.evaluate(({ payload, mediaVersion }) => window.__roomSocket.send(JSON.stringify({ ...payload, mediaVersion, commandId: crypto.randomUUID() })), { payload, mediaVersion: viewer.state().mediaVersion });
        }
        const selectedAt = Date.now();
        await command(h, { type: 'set_media', media: { releaseId: 10, releaseName: 'Browser fixture', dubId: 20, sourceId: 30, episode: 1, episodeName: 'First episode' } });
        await waitFor(() => h.state()?.participants.find(p => p.profileId === 1)?.status === 'ready', 'host real MP4 loaded');
        console.log('Browser fixture: native MP4 loaded while guest extraction is delayed.');
        await waitFor(() => h.state()?.playback.paused === false && h.state()?.barrier === null, 'deadline resumes ready viewer');
        assert.ok(Date.now() - selectedAt >= 6500, 'room waited approximately seven seconds');
        assert.equal(h.state().participants.find(p => p.profileId === 2).connected, true);
        assert.equal(h.state().participants.find(p => p.profileId === 2).excludedEpoch, h.state().syncEpoch);
        await waitFor(() => h.page.locator('video').evaluate(v => !v.paused && v.currentTime > .5), 'real host playback advances');
        console.log('Browser fixture: 7s timeout resumed without kicking the guest.');
        holdGuest = false; releaseGuest();
        await waitFor(() => g.state()?.participants.find(p => p.profileId === 2)?.status === 'ready', 'late viewer catches up');
        await waitFor(async () => {
            const [a, b] = await Promise.all([h.page.locator('video').evaluate(v => v.currentTime), g.page.locator('video').evaluate(v => v.currentTime)]);
            return a > 1 && b > 1 && Math.abs(a - b) < .8;
        }, 'two real media clocks converge');
        console.log('Browser fixture: late viewer media clock converged.');
        await mkdir('test-results', { recursive: true });
        await h.page.screenshot({ path: 'test-results/player-browser.png', fullPage: true });
        // This command uses the actual React control, not the raw test socket.
        await h.page.getByRole('button', { name: 'Pause', exact: true }).click();
        await waitFor(() => h.state()?.playback.intent === 'paused' && g.state()?.playback.paused, 'UI pause propagates');
        const times = await Promise.all([h.page.locator('video').evaluate(v => v.currentTime), g.page.locator('video').evaluate(v => v.currentTime)]);
        await delay(1200);
        assert.ok(Math.abs(await g.page.locator('video').evaluate(v => v.currentTime) - times[1]) < .15);
        await h.page.getByRole('button', { name: 'Player settings', exact: true }).click();
        await h.page.getByRole('button', { name: '720p', exact: true }).click();
        await waitFor(() => h.page.locator('video').evaluate(v => v.readyState >= 3 && v.currentSrc.includes('720')), 'local quality switch completes');
        assert.ok(Math.abs(await h.page.locator('video').evaluate(v => v.currentTime) - times[0]) < .8);
        assert.equal(await h.page.locator('video').evaluate(v => v.paused), true);
        // Browser native pause/load events must not create a feedback loop.
        const before = h.snapshots.length; await delay(1200); assert.ok(h.snapshots.length - before < 5);
        await g.page.reload();
        await waitFor(() => g.page.evaluate(() => document.querySelector('video')?.readyState >= 3), 'private player refresh restores media without URL code');
        await waitFor(() => g.state()?.participants.find(p => p.profileId === 2)?.status === 'ready', 'refreshed viewer is ready');
        assert.equal(await g.page.locator('video').evaluate(v => v.paused), true);
        await command(h, { type: 'set_media', media: { releaseId: 10, releaseName: 'Browser fixture', dubId: 20, sourceId: 30, episode: 2, episodeName: 'Second episode' } });
        await waitFor(() => h.state()?.mediaVersion === 2 && h.state()?.participants.filter(p => p.viewing && p.status === 'ready').length === 2, 'real HLS media loads for both viewers');
        await waitFor(async () => {
            const [a, b] = await Promise.all([h.page.locator('video').evaluate(v => !v.paused && v.currentTime), g.page.locator('video').evaluate(v => !v.paused && v.currentTime)]);
            return a > .5 && b > .5 && Math.abs(a - b) < .8;
        }, 'real hls.js media clocks converge');
        console.log('Browser fixture: real local HLS segments play and converge.');
        await h.page.getByRole('button', { name: 'Pause', exact: true }).click();
        await waitFor(() => h.state()?.playback.intent === 'paused', 'HLS pause');
        await h.page.getByRole('button', { name: 'Room', exact: true }).click();
        assert.equal(await h.page.locator('#watch-room-panel header h2').evaluate(title => getComputedStyle(title).color), 'rgb(244, 245, 247)', 'room panel stays readable in the light app theme');
        await h.page.getByLabel('Actions for viewer2').click();
        await h.page.getByRole('button', { name: 'Transfer host', exact: true }).click();
        const transferDialog = h.page.getByRole('dialog', { name: 'Make viewer2 the host?' });
        await transferDialog.waitFor();
        assert.equal(h.state()?.hostId, 1, 'transfer does not happen before confirmation');

        // Verify cancel preserves role and membership
        await transferDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(h.state()?.hostId, 1, 'cancel preserves host role');
        assert.ok(h.state()?.participants.some(p => p.profileId === 2 && p.connected), 'cancel preserves viewer2 membership');

        // Reopen menu and confirm transfer
        await h.page.getByLabel('Actions for viewer2').click();
        await h.page.getByRole('button', { name: 'Transfer host', exact: true }).click();
        await transferDialog.waitFor();
        await transferDialog.getByRole('button', { name: 'Transfer host', exact: true }).click();
        await waitFor(() => h.state()?.hostId === 2 && g.state()?.hostId === 2, 'manual transfer');
        await h.page.screenshot({ path: 'test-results/player-room-panel.png', fullPage: true });
        const hostSocketCount = h.snapshots.length;
        await h.page.getByRole('button', { name: 'You are in a room — return', exact: true }).click();
        await waitFor(() => h.state()?.participants.find(p => p.profileId === 1)?.viewing === false, 'closing player keeps room membership');
        assert.equal(h.state().participants.find(p => p.profileId === 1).connected, true);
        assert.ok(h.snapshots.length > hostSocketCount, 'same subscription receives the viewing=false transition');
        await g.page.goto(`${origin}/together/${roomId}`);
        await g.page.getByRole('button', { name: 'Leave', exact: true }).click();
        const leaveDialog = g.page.getByRole('dialog', { name: 'Leave this room?' });
        await leaveDialog.waitFor();
        assert.equal(g.state()?.hostId, 2, 'host leave does not happen before confirmation');

        // Verify cancel preserves role and membership
        await leaveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(g.state()?.hostId, 2, 'cancel preserves host role');
        assert.ok(g.state()?.participants.some(p => p.profileId === 2), 'cancel preserves membership');

        // Leave and confirm
        await g.page.getByRole('button', { name: 'Leave', exact: true }).click();
        await leaveDialog.waitFor();
        await leaveDialog.getByRole('button', { name: 'Leave room', exact: true }).click();
        await waitFor(() => h.state()?.hostId === 1, 'host leave transfers role');
        assert.deepEqual(failures, [], 'no uncaught browser errors');
        await mkdir('test-results', { recursive: true });
        await h.page.screenshot({ path: 'test-results/room-browser.png', fullPage: true });
        console.log('Real MP4/HLS, two independent Chromium contexts, 7s barrier, late catch-up, paused quality switch, private refresh, UI pause, navigation and host transfer passed.');

        // -------------------------------------------------------------------------
        // Isolated Browser Check 1: Malformed Settings Import
        // -------------------------------------------------------------------------
        console.log('Browser fixture: checking malformed settings import...');
        {
            const settingsContext = await browser.newContext();
            const initialSettings = { appearance: { language: 'english', theme: 'dark' }, player: { volume: 77, autoplay: false } };
            await settingsContext.addInitScript(({ initialSettings }) => {
                localStorage.setItem('onboarded', 'true');
                localStorage.setItem('app_settings', JSON.stringify(initialSettings));
            }, { initialSettings });
            const settingsPage = await settingsContext.newPage();
            const settingsErrors = [];
            settingsPage.on('pageerror', err => settingsErrors.push(err.message));
            await settingsPage.goto(`${origin}/settings`);

            await settingsPage.getByRole('tab', { name: /Data/i }).click();
            await settingsPage.getByTestId('settings-backup-file').setInputFiles({
                name: 'malformed.json',
                mimeType: 'application/json',
                buffer: Buffer.from('{ malformed: "invalid json content" ')
            });

            const alert = settingsPage.getByRole('alert').filter({ hasText: 'Failed to import settings' });
            await alert.waitFor({ timeout: 5000 });
            assert.ok(await alert.isVisible(), 'error alert is shown on malformed import');

            const preserved = await settingsPage.evaluate(() => JSON.parse(localStorage.getItem('app_settings') || '{}'));
            assert.equal(preserved.player?.volume, 77, 'volume is preserved');
            assert.equal(preserved.appearance?.theme, 'dark', 'theme is preserved');
            assert.deepEqual(settingsErrors, [], 'no uncaught page errors on malformed import');
            await settingsPage.close();
            await settingsContext.close();
            console.log('Browser fixture: malformed settings import rejected without crash or overwrite.');
        }

        // -------------------------------------------------------------------------
        // Isolated Browser Check 2: Root and Subpath PWA Assets
        // -------------------------------------------------------------------------
        console.log('Browser fixture: checking root and subpath PWA assets...');
        {
            const pwaContext = await browser.newContext();
            const pwaPage = await pwaContext.newPage();

            // Root manifest
            const rootManifestRes = await pwaPage.request.get(`${origin}/manifest.webmanifest`);
            assert.equal(rootManifestRes.status(), 200, 'root manifest 200');
            const manifestJson = await rootManifestRes.json();
            assert.equal(manifestJson.start_url, './', 'manifest start_url relative');
            assert.equal(manifestJson.scope, './', 'manifest scope relative');

            // Root sw
            const rootSwRes = await pwaPage.request.get(`${origin}/sw.js`);
            assert.equal(rootSwRes.status(), 200, 'root sw.js 200');
            const swText = await rootSwRes.text();
            assert.ok(swText.includes('anixweb-v2-'), 'sw has isolated cache name');

            // Root icons
            for (const iconPath of ['icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']) {
                const res = await pwaPage.request.get(`${origin}/${iconPath}`);
                assert.equal(res.status(), 200, `root ${iconPath} 200`);
                assert.ok((await res.body()).length > 0, `root ${iconPath} non-empty`);
            }

            // Subpath PWA asset serving & resolution
            const subManifestRes = await pwaPage.request.get(`${origin}/anixweb/manifest.webmanifest`);
            assert.equal(subManifestRes.status(), 200, 'subpath manifest 200');

            const subSwRes = await pwaPage.request.get(`${origin}/anixweb/sw.js`);
            assert.equal(subSwRes.status(), 200, 'subpath sw.js 200');

            const subIconRes = await pwaPage.request.get(`${origin}/anixweb/icons/icon-192.png`);
            assert.equal(subIconRes.status(), 200, 'subpath icon-192 200');

            // Check URL resolution under subpath
            const subpathManifestUrl = `${origin}/anixweb/manifest.webmanifest`;
            const resolvedStartUrl = new URL(manifestJson.start_url, subpathManifestUrl).href;
            assert.equal(resolvedStartUrl, `${origin}/anixweb/`, 'subpath start_url resolves to subpath base');
            const resolvedIconUrl = new URL(manifestJson.icons[0].src, subpathManifestUrl).href;
            assert.equal(resolvedIconUrl, `${origin}/anixweb/icons/icon-192.png`, 'subpath icon resolves to subpath');

            await pwaPage.close();
            await pwaContext.close();
            console.log('Browser fixture: root and subpath PWA assets verified.');
        }

    } catch (error) {
        if (hostPage && !hostPage.isClosed()) {
            console.log('Browser diagnostic:', await hostPage.locator('body').innerText());
            console.log('Uncaught errors:', failures);
            await mkdir('test-results', { recursive: true });
            await hostPage.screenshot({ path: 'test-results/browser-failure.png', fullPage: true });
        }
        throw error;
    } finally {
        releaseGuest?.(); await browser?.close(); await vite?.close(); await mf?.dispose();
        if (cacheDirectory && resolve(dirname(cacheDirectory)) === resolve(tmpdir()) && basename(cacheDirectory).startsWith('anixweb-playback-vite-')) {
            await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }
});
