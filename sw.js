const CACHE_NAME = 'clipgrab-shell-v3';
const MEDIA_CACHE_NAME = 'clipgrab-media-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/favicon.ico', '/icons/icon-180x180.png', '/icons/icon-192x192.png', '/icons/icon-384x384.png', '/icons/icon-512x512.png', '/icons/icon-maskable.png'];
let offlineEnabled = false;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME && key !== MEDIA_CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'offline-setting') offlineEnabled = Boolean(event.data.enabled);
  if (event.data?.type === 'clear-offline') event.waitUntil(caches.delete(MEDIA_CACHE_NAME));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  const isMediaPreview = url.pathname === '/api/preview' || (url.pathname === '/api/download' && url.searchParams.get('preview') === '1');
  if (isMediaPreview) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (offlineEnabled && response.ok) caches.open(MEDIA_CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    })));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
