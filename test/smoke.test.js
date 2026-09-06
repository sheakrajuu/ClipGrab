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
  const [page, manifest, worker, maskableIcon] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/manifest.webmanifest`),
    fetch(`${baseUrl}/sw.js`),
    fetch(`${baseUrl}/icons/icon-maskable.png`)
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ClipGrab/);
  assert.equal(manifest.status, 200);
  const manifestData = await manifest.json();
  assert.equal(manifestData.short_name, 'ClipGrab');
  assert.ok(manifestData.icons.some(icon => icon.src === '/icons/icon-maskable.png' && icon.purpose === 'maskable'));
  assert.equal(worker.status, 200);
  const workerText = await worker.text();
  assert.match(workerText, /clipgrab-shell-v3/);
  assert.match(workerText, /icon-maskable\.png/);
  assert.equal(maskableIcon.status, 200);
  assert.match(maskableIcon.headers.get('content-type'), /image\/png/);
});

test('video extraction finds lazy-loaded video sources', async () => {
  const videos = await app.extractPageVideos(new URL(fixtureUrl));
  assert.deepEqual(videos, [`${new URL(fixtureUrl).origin}/media/launch.mp4`]);
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
