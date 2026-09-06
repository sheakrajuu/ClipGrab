const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('health endpoint returns service status and request id', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('homepage and PWA assets are available', async () => {
  const [page, manifest, worker] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/manifest.webmanifest`),
    fetch(`${baseUrl}/sw.js`)
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ClipGrab/);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).short_name, 'ClipGrab');
  assert.equal(worker.status, 200);
  assert.match(await worker.text(), /CACHE_NAME/);
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
