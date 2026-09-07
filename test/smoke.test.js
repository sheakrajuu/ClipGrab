const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server');

let server;
let baseUrl;
let fixtureServer;
let fixtureUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  fixtureServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    if (request.url === '/page-1') return response.end('<img src="/one.jpg"><a rel="next" href="/page-2">Next</a>');
    if (request.url === '/page-2') return response.end('<img src="/two.jpg">');
    response.end('<meta property="og:image" content="/poster.jpg"><video data-video-src="/media/launch.mp4"></video>');
  }).listen(0);
  await new Promise(resolve => fixtureServer.once('listening', resolve));
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/video-page`;
});

test.after(() => { server.close(); fixtureServer.close(); });

test('health endpoint returns service status and request id', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('homepage and PWA assets are available', async () => {
  const [page, manifest, worker, appIcon] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/manifest.webmanifest`),
    fetch(`${baseUrl}/sw.js`),
    fetch(`${baseUrl}/icons/icon-app-512.png`)
  ]);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /ClipGrab/);
  assert.match(pageText, /id="paste-btn"/);
  assert.match(pageText, /Checking link\.\.\./);
  assert.match(pageText, /Try another link/);
  assert.match(pageText, /5 videos/);
  assert.match(pageText, /20 images/);
  assert.match(pageText, /Are you 18 or older/);
  assert.match(pageText, /id="website-scan-url"/);
  assert.match(pageText, /value="100"/);
  assert.equal(manifest.status, 200);
  const manifestData = await manifest.json();
  assert.equal(manifestData.short_name, 'ClipGrab');
  assert.ok(manifestData.icons.some(icon => icon.src === '/icons/icon-app-512.png?v=1' && icon.purpose === 'any maskable'));
  assert.equal(worker.status, 200);
  const workerText = await worker.text();
  assert.match(workerText, /clipgrab-shell-v5/);
  assert.match(workerText, /icon-app-192\.png\?v=1/);
  assert.equal(appIcon.status, 200);
  assert.match(appIcon.headers.get('content-type'), /image\/png/);
});

test('video extraction finds lazy-loaded video sources', async () => {
  const videos = await app.extractPageVideos(new URL(fixtureUrl));
  assert.deepEqual(videos, [`${new URL(fixtureUrl).origin}/media/launch.mp4`]);
});

test('website image scan follows same-origin pagination', async () => {
  const result = await app.scanWebsiteImages(new URL('/page-1', fixtureUrl), 10);
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.pageLimit, 10);
  assert.deepEqual(result.images, [`${new URL(fixtureUrl).origin}/one.jpg`, `${new URL(fixtureUrl).origin}/two.jpg`]);
});

test('focused SEO pages are available with page-specific metadata', async () => {
  const response = await fetch(`${baseUrl}/web-image-downloader`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Web image downloader/);
  assert.match(html, /canonical/);
});

test('invalid media requests return a useful error', async () => {
  const response = await fetch(`${baseUrl}/api/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'not-a-url' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid URL/i);
});
