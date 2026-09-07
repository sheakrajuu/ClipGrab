const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server');

let server;
let baseUrl;
let fixtureServer;
let fixtureUrl;
let imageFixtureUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  fixtureServer = http.createServer((request, response) => {
    if (request.url === '/image-page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<meta property="og:image" content="/poster.jpg"><img src="/poster.jpg">');
      return;
    }
    if (request.url === '/poster.jpg') {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(Buffer.from([255, 216, 255, 217]));
      return;
    }
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
  const [page, manifest, worker, appIcon] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/manifest.webmanifest`),
    fetch(`${baseUrl}/sw.js`),
    fetch(`${baseUrl}/icons/android-chrome-512x512.png`)
  ]);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /ClipGrab/);
  assert.match(pageText, /id="settings-btn"/);
  assert.match(pageText, /Media Hub/);
  assert.match(pageText, /data-settings-section="history"/);
  assert.match(pageText, /id="saved-batch-list"/);
  assert.match(pageText, /id="private-mode"/);
  assert.match(pageText, /id="clear-image-cache-btn"/);
  assert.match(pageText, /id="clear-video-cache-btn"/);
  assert.match(pageText, /id="clear-audio-cache-btn"/);
  assert.match(pageText, /id="jump-overlay"/);
  imageFixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/image-page`;
  assert.equal(manifest.status, 200);
  const manifestData = await manifest.json();
  assert.equal(manifestData.short_name, 'ClipGrab');
  assert.ok(manifestData.icons.some(icon => icon.src === '/icons/android-chrome-512x512.png?v=7' && icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.equal(worker.status, 200);
  const workerText = await worker.text();
  assert.match(workerText, /clipgrab-shell-v9/);
  assert.match(workerText, /android-chrome-512x512\.png\?v=7/);
  assert.equal(appIcon.status, 200);
  assert.match(appIcon.headers.get('content-type'), /image\/png/);
});

test('extractor arguments keep the original URL separate from cache mode', () => {
  assert.deepEqual(app.extractorArgs('https://example.com/video'), [
    '--dump-single-json', '--yes-playlist', '--no-warnings', '--socket-timeout', '20',
    '--retries', '2', '--fragment-retries', '2', '--concurrent-fragments', '4',
    'https://example.com/video'
  ]);
});

test('video extraction finds lazy-loaded video sources', async () => {
  const videos = await app.extractPageVideos(new URL(fixtureUrl));
  assert.deepEqual(videos, [`${new URL(fixtureUrl).origin}/media/launch.mp4`]);
});

test('image scans return images without invoking the video extractor', async () => {
  const images = await app.extractPageImages(new URL(imageFixtureUrl));
  assert.deepEqual(images, [`${new URL(imageFixtureUrl).origin}/poster.jpg`]);
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
